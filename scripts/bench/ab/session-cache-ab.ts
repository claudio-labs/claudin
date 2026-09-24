#!/usr/bin/env bun
/**
 * Session cache A/B — Claude Code (`claude`) vs this checkout (`claudindev`),
 * both on Opus 5.5, over one realistic two-prompt session on a throwaway
 * TypeScript project. One run answers three questions:
 *
 *  - CACHE: what each CLI sends on every turn — context, cache read, cache
 *    write split by TTL, the uncached tail — and whether the prefix survives
 *    the whole session, including the `--resume` into a new process between
 *    the two prompts.
 *  - TOOLS: which tools each CLI reaches for, how much each one puts back into
 *    the context, and what the redirects (Bash → RunTests/Git) cost in turns.
 *  - BASH FILTER: whether claudindev's Bash results really carry the filter's
 *    markers, and what the filter would have done to claude's raw Bash output
 *    (replayed through `scripts/bench/tokens/measure-bash-filter-replay.test.ts`).
 *
 * The session is two prompts. Phase 1 asks for two features and a bug fix, with
 * tests. Phase 2 resumes the same session (`--resume <id>`: a new process, the
 * "user comes back with a follow-up" shape) and asks for a third feature plus
 * a commit. Each phase has a turn cap (35 + 20 by default) so the whole session
 * stays around 50 turns.
 *
 * The fixture lives in `__fixtures__/session-cache-ab/` as `.tpl` files, so this
 * repo's own `bun test` never discovers the tests inside it:
 *   project/   the pristine project, byte-identical for every arm and rep
 *   hidden/    black-box acceptance tests + carts/catalogs, never shown to a model
 *   solution/  a reference implementation, overlaid by --dry-run only
 *   prompts/   the two user prompts
 *
 * Protocol:
 *  - Every arm gets its own workspace under /tmp/session-cache-ab/<stamp>/, a
 *    git repo with one pinned commit, so session state (keyed by project dir)
 *    never collides with this checkout's or with the other arm's.
 *  - Model and effort are pinned on both arms, and both bypass permissions, so
 *    neither pays for a permission classifier the other does not run.
 *  - The two arms of a rep run CONCURRENTLY. Their prefixes differ, so neither
 *    warms the other's cache; side by side they inherit the same warmth from
 *    the previous rep instead of one of them always paying cold.
 *  - Usage is merged across the stream and the transcript, max per field per
 *    message id (see the team memory `token-bench-measurement-traps`).
 *  - Every run is graded after each phase before its tokens are believed: a
 *    cheap arm that skipped half the work is not a win.
 *  - The host session's CLAUDECODE / CLAUDE_CODE_* / CLAUDIN_* variables are
 *    stripped, so each arm starts as it would from a clean terminal.
 *
 * Usage:
 *   bun scripts/bench/ab/session-cache-ab.ts --dry-run          # validate fixture + grader, no tokens
 *   bun scripts/bench/ab/session-cache-ab.ts                    # 1 rep, both arms in parallel
 *   bun scripts/bench/ab/session-cache-ab.ts --reps=3
 *   bun scripts/bench/ab/session-cache-ab.ts --only=claudindev --max-turns=35,20
 *   bun scripts/bench/ab/session-cache-ab.ts --only=nodefer --variant=nodefer:CLAUDIN_DEFER_CACHE_MARKER=0
 *   bun scripts/bench/ab/session-cache-ab.ts --replay=/tmp/session-cache-ab/<stamp>/results.json
 *   bun scripts/bench/ab/session-cache-ab.ts --replay=a/results.json,b/results.json --only=claudindev,nodefer
 *   bun scripts/bench/ab/session-cache-ab.ts --replay=new/results.json@after,old/results.json@before \
 *     --only=claudindev@before,claudindev@after
 *
 * A `--variant=<label>:<ENV>=<value>[,<ENV>=<value>]` is one more arm: this
 * checkout's binary with those variables set, which is how a killswitch is
 * priced against the default without touching the source.
 *
 * `--arm-args=<label>:<args>` appends CLI arguments to both invocations of one
 * arm — how a tool is taken away without touching the source:
 *   bun scripts/bench/ab/session-cache-ab.ts --variant=nopatch --arm-args='nopatch:--disallowedTools Patch'
 *
 * `--proxy` routes every arm through `wire-proxy.ts`, a local recording proxy
 * in front of the real API, with each CLI's first-party override set. Every
 * request body and every response's usage lands in `<run dir>/proxy/`, and the
 * thinking count is then taken from there, at the source.
 * `bun scripts/bench/ab/wire-proxy.ts summarize <run dir>/proxy` prints what
 * each session sent, request by request.
 * `--proxy-display=summarized` (implies `--proxy`) has the proxy ask for the
 * thinking summary on every request of every arm, so what each model thought
 * about is readable (`thinking-diff.ts`). The API bills the full thinking
 * whatever the display, and the signature does not change.
 *
 * Cost by source: with no cache break, a token entering the context at call k
 * is written once there and read by every later call, so the priced cost splits
 * exactly into thinking, a patch re-sent after a refused edit, other visible
 * output, the first request (prefix) and tool results plus reminders — each
 * priced where it entered. Thinking is the API's count
 * (`usage.output_tokens_details.thinking_tokens`), per message: both CLIs keep
 * it in their transcripts, though Claude Code's stream-json only has the
 * per-process total in its `result`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl, transcriptPath } from './cliUsage'
import { proxyEnv, readProxyThinking, startWireProxy, thinkingDisplayTransform, type WireProxy } from './wire-proxy'

/** 'claude', 'claudindev', or the label of a --variant. */
type Arm = string
const ARMS: readonly Arm[] = ['claude', 'claudindev']
type Phase = 1 | 2
const PHASES: readonly Phase[] = [1, 2]

const FIXTURE = join(import.meta.dir, '__fixtures__', 'session-cache-ab')
const BENCH_ROOT = '/tmp/session-cache-ab'
const TPL_SUFFIX = '.tpl'
const REPLAY_TEST = 'scripts/bench/tokens/measure-bash-filter-replay.test.ts'

/** A turn that failed to read back more than this much of the previous prefix broke the cache. */
const BREAK_TOKENS = 2048

// ---------------------------------------------------------------------------
// Prices — USD per 1M tokens. Opus 5.5 is claudin's COST_TIER_4_20 and
// Sonnet 5 its COST_TIER_2_10 (src/providers/usage/modelCost.ts); on the smoke
// run the Opus row reproduced both CLIs' own total_cost_usd to the last digit,
// so the arms are priced by one table instead of by each CLI's opinion of itself.
// ---------------------------------------------------------------------------

type Price = { in: number; out: number; w5m: number; w1h: number; read: number }
const PRICES: Array<[RegExp, Price]> = [
  [/opus-5-5/, { in: 4, out: 20, w5m: 5, w1h: 8, read: 0.2 }],
  [/sonnet-5/, { in: 2, out: 10, w5m: 2.5, w1h: 4, read: 0.2 }],
  [/opus/, { in: 5, out: 25, w5m: 6.25, w1h: 10, read: 0.5 }],
  [/sonnet/, { in: 3, out: 15, w5m: 3.75, w1h: 6, read: 0.3 }],
  [/haiku/, { in: 1, out: 5, w5m: 1.25, w1h: 2, read: 0.1 }],
]

type Usage = { in: number; out: number; cR: number; cW: number; cW5m: number; cW1h: number }
const USAGE_KEYS: ReadonlyArray<keyof Usage> = ['in', 'out', 'cR', 'cW', 'cW5m', 'cW1h']
const zeroUsage = (): Usage => ({ in: 0, out: 0, cR: 0, cW: 0, cW5m: 0, cW1h: 0 })

function priceOf(model: string): Price {
  return PRICES.find(([re]) => re.test(model))?.[1] ?? PRICES[0]![1]
}

function costOf(model: string, u: Usage): number {
  const price = priceOf(model)
  // A write the API did not split by TTL is priced at the cheaper tier.
  const unsplit = Math.max(0, u.cW - u.cW5m - u.cW1h)
  return (
    (u.in * price.in + u.out * price.out + (u.cW5m + unsplit) * price.w5m + u.cW1h * price.w1h + u.cR * price.read) /
    1e6
  )
}

function addUsage(into: Usage, u: Usage): void {
  for (const k of USAGE_KEYS) into[k] += u[k]
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Args = {
  reps: number
  only: Arm[] | null
  sequential: boolean
  model: string
  effort: string
  maxTurns: [number, number]
  budgetUsd: number
  gapSec: number
  timeoutMs: number
  dryRun: boolean
  replay: string
  replayBash: boolean
  bins: Record<Arm, string>
  /** Extra environment per arm — set only for --variant arms. */
  env: Record<Arm, Record<string, string>>
  /** Extra CLI arguments per arm (--arm-args), appended to both phases. */
  args: Record<Arm, string[]>
  variants: Arm[]
  proxy: boolean
  /** `thinking.display` the proxy forces on every request (--proxy-display). */
  proxyDisplay: string | null
}

type PhaseRun = {
  phase: Phase
  exitCode: number
  timedOut: boolean
  wallMs: number
  sessionId: string | null
  subtype: string | null
  numTurns: number | null
  cliCostUsd: number | null
  /** `result.usage.output_tokens_details.thinking_tokens`: this process only, on both CLIs. */
  thinkingTokens: number | null
  modelUsage: Record<string, Record<string, number>>
  initTools: number | null
  messageIds: string[]
  stderrTail: string
}

type Turn = Usage & {
  n: number
  phase: Phase
  id: string
  model: string
  ctx: number
  /** Tokens the previous request had in cache that this one did not read back. */
  lost: number | null
  tools: string[]
  resultChars: number
  /** Thinking tokens of this call; null until `fillThinking` knows. */
  think: number | null
  /** Chars of what the call showed: text blocks plus tool_use inputs. */
  visibleChars: number
}

type Call = {
  turn: number
  phase: Phase
  name: string
  input: Record<string, unknown>
  chars: number
  isError: boolean
  /** The harness answered instead of the tool: a redirect, a read-first gate, a denial. */
  refused: boolean
  /** A read-gate refusal that also served the lines it refused over. */
  served?: boolean
  /** Kept for Bash only: the replay corpus is rebuilt from it. */
  text?: string
}

type SubagentUsage = { files: number; turns: number; usage: Usage; costUsd: number; models: string[] }

type TestRun = { ok: boolean; pass: number; fail: number; failed: string[] }

type GitGrade = {
  commits: number
  subject: string
  conventional: boolean
  /** An AI attribution footer in a commit message. Absent from a results.json written before the check: unknown, not clean. */
  trailer?: boolean
  clean: boolean
  status: string
}

type Grade = { tests: TestRun; hidden: TestRun[]; git: GitGrade | null }

type RunResult = {
  arm: Arm
  rep: number
  bin: string
  workspace: string
  sessionId: string | null
  model: string | null
  phases: PhaseRun[]
  turns: Turn[]
  calls: Call[]
  subagents: SubagentUsage
  grades: Grade[]
  gitStatus: string[]
  transcript: string | null
  usageSource: string
  /** Where `turns[].think` came from: the API per message, the proxy, one total per phase spread over its turns, or nowhere. */
  thinkSource?: 'message' | 'proxy' | 'phase-spread' | 'none'
}

type Meta = {
  started: string
  runDir: string
  model: string
  effort: string
  maxTurns: [number, number]
  gapSec: number
  reps: number
  arms: Arm[]
  versions: Record<string, string>
  armEnv?: Record<Arm, Record<string, string>>
  armArgs?: Record<Arm, string[]>
  proxy?: boolean
  proxyDisplay?: string | null
  baselineTests: number
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const blocksOf = (content: unknown): Json[] => (Array.isArray(content) ? content.filter(isRecord) : [])

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return blocksOf(content)
    .map(b => (typeof b.text === 'string' ? b.text : ''))
    .join('')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Copies a `.tpl` tree into `dest`, dropping the suffix. */
function materialize(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    if (entry.isDirectory()) {
      materialize(from, join(dest, entry.name))
      continue
    }
    const name = entry.name.endsWith(TPL_SUFFIX) ? entry.name.slice(0, -TPL_SUFFIX.length) : entry.name
    mkdirSync(dest, { recursive: true })
    copyFileSync(from, join(dest, name))
  }
}

/**
 * Pinned identity and dates, so every workspace's first commit has the same
 * hash — `git log` output is part of what the arms read.
 */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Bench User',
  GIT_AUTHOR_EMAIL: 'bench@example.invalid',
  GIT_AUTHOR_DATE: '2026-09-01T12:00:00Z',
  GIT_COMMITTER_NAME: 'Bench User',
  GIT_COMMITTER_EMAIL: 'bench@example.invalid',
  GIT_COMMITTER_DATE: '2026-09-01T12:00:00Z',
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.status === 0 ? '' : (r.stderr ?? '')}` }
}

export function makeWorkspace(dir: string): void {
  materialize(join(FIXTURE, 'project'), dir)
  const steps: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.invalid'],
    // The host's global config signs commits; a headless arm has no pinentry,
    // and whichever arm first hit that would spend turns on it.
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', '.git/no-hooks'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'chore: import pricing-engine 0.3.0'],
  ]
  for (const step of steps) {
    const r = git(dir, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${dir}: ${r.out}`)
  }
}

/** The grader dir: hidden tests and their data, plus a copy of the shipped catalog. */
function makeGrader(runDir: string): string {
  const dir = join(runDir, 'grader')
  materialize(join(FIXTURE, 'hidden'), dir)
  copyFileSync(join(FIXTURE, 'project', 'data', `catalog.json${TPL_SUFFIX}`), join(dir, 'catalog.json'))
  return dir
}

function readPrompt(phase: Phase): string {
  return readFileSync(join(FIXTURE, 'prompts', `phase${phase}.md`), 'utf8').trim()
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const TEST_RESULT_RE = /^\((pass|fail)\) (.+?)(?: \[[\d.]+m?s\])?$/gm
const TEST_COUNT_RE = /^\s*(\d+) (pass|fail)$/gm
const CONVENTIONAL_RE = /^(feat|fix|refactor|test|chore|docs|perf|build|ci|style)(\([^)]*\))?!?: \S/
/**
 * An AI attribution footer: a `Co-Authored-By:` naming a model or its maker (what
 * Claude Code appends to every commit), a "Generated with Claude Code/Claudin"
 * line, or the 🤖 marker. claudin's commit protocol forbids them, and the
 * subject alone never shows one.
 */
const AI_TRAILER_RE =
  /^[ \t]*co-authored-by:.*\b(?:claude|claudin|anthropic|openai|chatgpt|gpt|codex|copilot|gemini|ai)\b|generated (?:with|by) \[?(?:claude|claudin)|🤖/imu

function bunTest(cwd: string, files: string[], env: Record<string, string> = {}): TestRun {
  const r = spawnSync('bun', ['test', ...files], {
    cwd,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, ...env },
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  let pass = 0
  let fail = 0
  for (const m of out.matchAll(TEST_COUNT_RE)) {
    if (m[2] === 'pass') pass = Number(m[1])
    else fail = Number(m[1])
  }
  const failed = [...out.matchAll(TEST_RESULT_RE)].filter(m => m[1] === 'fail').map(m => m[2]!)
  return { ok: r.status === 0, pass, fail, failed }
}

function hiddenRun(graderDir: string, ws: string, phase: Phase): TestRun {
  return bunTest(graderDir, [`./phase${phase}.acceptance.test.ts`], { SCA_WORKSPACE: ws })
}

function gitGrade(ws: string): GitGrade {
  const subjects = git(ws, 'log', '--format=%s').out.trim().split('\n').filter(Boolean)
  const status = git(ws, 'status', '--porcelain').out.trim()
  const subject = subjects[0] ?? ''
  return {
    commits: subjects.length,
    subject,
    conventional: subjects.length > 1 && CONVENTIONAL_RE.test(subject),
    // Every message, the pinned import commit's too: it carries no footer, so a
    // hit is the model's even when it amended that commit instead of adding one.
    trailer: AI_TRAILER_RE.test(git(ws, 'log', '--format=%B').out),
    clean: status === '',
    status,
  }
}

function gradePhase(ws: string, graderDir: string, phase: Phase): Grade {
  const hidden = PHASES.filter(p => p <= phase).map(p => hiddenRun(graderDir, ws, p))
  return { tests: bunTest(ws, []), hidden, git: phase === 2 ? gitGrade(ws) : null }
}

// ---------------------------------------------------------------------------
// Running an arm
// ---------------------------------------------------------------------------

/**
 * The host session's own variables must not reach the arms: CLAUDECODE and
 * CLAUDE_CODE_ENTRYPOINT change how `claude` classifies itself, and the
 * CLAUDIN_* ones are either defaults claudin re-applies on its own or choices of
 * the host that an arm launched from a terminal would not have.
 */
const HOST_ENV_RE = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDIN_(?!CONFIG_DIR$))/

function armEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!HOST_ENV_RE.test(k)) env[k] = v
  return {
    ...env,
    // `-p` drains auto-backgrounded work non-deterministically, and an orphaned
    // task takes its tokens with it (agent-safety.md §5).
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDIN_DISABLE_BACKGROUND_TASKS: '1',
    DISABLE_AUTOUPDATER: '1',
    ...extra,
  }
}

function spawnCollect(
  bin: string,
  args: string[],
  cwd: string,
  base: string,
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<{ code: number; timedOut: boolean; wallMs: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const t0 = performance.now()
    const streamFile = createWriteStream(`${base}.stream.jsonl`)
    const out: Buffer[] = []
    const err: Buffer[] = []
    const child = spawn(bin, args, { cwd, env: armEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      out.push(d)
      streamFile.write(d)
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    const finish = (code: number) => {
      clearTimeout(timer)
      streamFile.end()
      const stderr = Buffer.concat(err).toString('utf8')
      writeFileSync(`${base}.stderr.txt`, stderr)
      resolve({ code, timedOut, wallMs: performance.now() - t0, stdout: Buffer.concat(out).toString('utf8'), stderr })
    }
    child.on('error', e => {
      err.push(Buffer.from(String(e)))
      finish(-1)
    })
    child.on('close', code => finish(code ?? -1))
  })
}

type RunContext = { args: Args; runDir: string; graderDir: string; proxy: WireProxy | null }

async function runPhase(
  arm: Arm,
  ws: string,
  phase: Phase,
  resumeId: string | null,
  ctx: RunContext,
  label: string,
): Promise<{ run: PhaseRun; events: Json[] }> {
  const { args } = ctx
  const cli = [
    '-p',
    readPrompt(phase),
    '--model',
    args.model,
    '--effort',
    args.effort,
    '--max-turns',
    String(args.maxTurns[phase - 1]),
    '--max-budget-usd',
    String(args.budgetUsd),
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(args.args[arm] ?? []),
  ]
  if (resumeId) cli.push('--resume', resumeId)
  const extraEnv = {
    ...(args.env[arm] ?? {}),
    ...(ctx.proxy ? proxyEnv(ctx.proxy.url(`${label}.p${phase}`)) : {}),
  }
  const res = await spawnCollect(
    args.bins[arm]!,
    cli,
    ws,
    join(ctx.runDir, `${label}.p${phase}`),
    args.timeoutMs,
    extraEnv,
  )
  const events = parseJsonl(res.stdout) as Json[]
  const init = events.find(e => e.type === 'system' && e.subtype === 'init')
  const result = events.findLast(e => e.type === 'result')
  const messageIds: string[] = []
  for (const e of events) {
    if (e.type !== 'assistant' || !isRecord(e.message)) continue
    const id = e.message.id
    if (typeof id === 'string' && !messageIds.includes(id)) messageIds.push(id)
  }
  const sessionId =
    typeof init?.session_id === 'string' ? init.session_id : typeof result?.session_id === 'string' ? result.session_id : null
  return {
    events,
    run: {
      phase,
      exitCode: res.code,
      timedOut: res.timedOut,
      wallMs: res.wallMs,
      sessionId,
      subtype: typeof result?.subtype === 'string' ? result.subtype : null,
      numTurns: typeof result?.num_turns === 'number' ? result.num_turns : null,
      cliCostUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
      thinkingTokens: thinkingFromResult(result),
      modelUsage: isRecord(result?.modelUsage) ? (result.modelUsage as PhaseRun['modelUsage']) : {},
      initTools: Array.isArray(init?.tools) ? init.tools.length : null,
      messageIds,
      stderrTail: res.stderr.trim().split('\n').slice(-5).join('\n'),
    },
  }
}

async function runArm(arm: Arm, rep: number, ctx: RunContext): Promise<RunResult> {
  const label = `${arm}-r${rep}`
  const ws = join(ctx.runDir, label)
  makeWorkspace(ws)
  const phases: PhaseRun[] = []
  const streams: Json[][] = []
  const grades: Grade[] = []
  const gitStatus: string[] = []
  let sessionId: string | null = null

  for (const phase of PHASES) {
    if (phase === 2) {
      if (!sessionId) break
      if (ctx.args.gapSec > 0) await sleep(ctx.args.gapSec * 1000)
    }
    const { run, events } = await runPhase(arm, ws, phase, sessionId, ctx, label)
    phases.push(run)
    streams.push(events)
    sessionId ??= run.sessionId
    gitStatus.push(git(ws, 'status', '--porcelain').out.trim())
    const grade = gradePhase(ws, ctx.graderDir, phase)
    grades.push(grade)
    const hidden = grade.hidden.map(h => `${h.pass}/${h.pass + h.fail}`).join(' + ')
    console.log(
      `[${label}] phase ${phase}: ${run.subtype ?? `exit ${run.exitCode}`}${run.timedOut ? ' (TIMED OUT)' : ''}, ` +
        `${run.messageIds.length} API calls, ${(run.wallMs / 1000).toFixed(0)}s, CLI $${(run.cliCostUsd ?? 0).toFixed(2)} — ` +
        `tests ${grade.tests.pass}/${grade.tests.pass + grade.tests.fail}, hidden ${hidden}` +
        (grade.git ? `, commits ${grade.git.commits} "${grade.git.subject}"${grade.git.trailer ? ' + AI trailer' : ''}` : ''),
    )
  }

  const tPath = sessionId ? transcriptPath(sessionId) : null
  let transcript: Json[] | null = null
  let archived: string | null = null
  if (tPath && existsSync(tPath)) {
    transcript = parseJsonl(readFileSync(tPath, 'utf8')) as Json[]
    archived = join(ctx.runDir, `${label}.transcript.jsonl`)
    copyFileSync(tPath, archived)
  }
  const phase2Ids = new Set(phases.find(p => p.phase === 2)?.messageIds ?? [])
  const session = analyzeSession(streams, phase2Ids, transcript)
  const proxyThinking = ctx.proxy ? readProxyThinking(ctx.proxy.logDir, PHASES.map(p => `${label}.p${p}`)) : null
  const thinkSource = fillThinking(session.turns, phases, proxyThinking)
  const subagents = tPath && sessionId ? subagentUsage(join(dirname(tPath), sessionId), join(ctx.runDir, `${label}.subagents`)) : emptySubagents()
  const model = session.turns[0]?.model ?? null

  return {
    arm,
    rep,
    bin: ctx.args.bins[arm]!,
    workspace: ws,
    sessionId,
    model,
    phases,
    turns: session.turns,
    calls: session.calls,
    subagents,
    grades,
    gitStatus,
    transcript: archived,
    usageSource: session.source,
    thinkSource,
  }
}

// ---------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------

type Row = Usage & {
  model: string
  toolUses: Map<string, { name: string; input: Json }>
  think: number | null
  texts: Set<string>
}

/**
 * One row per API call. Rows arrive once per CONTENT BLOCK, all sharing the
 * message id; the input and cache terms repeat while output_tokens grows, and
 * claude's stream flushes an early snapshot that only its transcript corrects —
 * so every field is the max over every sighting in every source.
 */
function collectRows(events: Json[], rows: Map<string, Row>, order: string[]): void {
  for (const e of events) {
    if (e.type !== 'assistant' || !isRecord(e.message)) continue
    const msg = e.message
    const u = msg.usage
    if (typeof msg.id !== 'string' || !isRecord(u) || msg.model === '<synthetic>') continue
    const cc = isRecord(u.cache_creation) ? u.cache_creation : {}
    const next: Usage = {
      in: num(u.input_tokens),
      out: num(u.output_tokens),
      cR: num(u.cache_read_input_tokens),
      cW: num(u.cache_creation_input_tokens),
      cW5m: num(cc.ephemeral_5m_input_tokens),
      cW1h: num(cc.ephemeral_1h_input_tokens),
    }
    const details = isRecord(u.output_tokens_details) ? u.output_tokens_details : null
    const think = details && typeof details.thinking_tokens === 'number' ? details.thinking_tokens : null
    let row = rows.get(msg.id)
    if (!row) {
      row = { ...next, model: String(msg.model ?? ''), toolUses: new Map(), think, texts: new Set() }
      rows.set(msg.id, row)
      order.push(msg.id)
    } else {
      for (const k of USAGE_KEYS) row[k] = Math.max(row[k], next[k])
      if (think !== null) row.think = Math.max(row.think ?? 0, think)
    }
    for (const block of blocksOf(msg.content)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) row.texts.add(block.text)
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || row.toolUses.has(block.id)) continue
      row.toolUses.set(block.id, { name: String(block.name ?? ''), input: isRecord(block.input) ? block.input : {} })
    }
  }
}

/**
 * Chars of what a call showed. Claude Code's stream flushes an early snapshot
 * of a text block that its transcript later completes, so a text that is a
 * prefix of another one is the snapshot and not counted twice.
 */
function visibleCharsOf(row: Row): number {
  const texts = [...row.texts]
  const kept = texts.filter(t => !texts.some(o => o !== t && o.startsWith(t)))
  let chars = kept.reduce((a, t) => a + t.length, 0)
  for (const use of row.toolUses.values()) chars += JSON.stringify(use.input).length
  return chars
}

function thinkingFromResult(result: Json | undefined): number | null {
  const usage = isRecord(result?.usage) ? result.usage : null
  const details = usage && isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
  return details && typeof details.thinking_tokens === 'number' ? details.thinking_tokens : null
}

/** Visible chars per output token, fitted on `-175528` (R² 0.99 with the signature length, same on both CLIs). */
const CHARS_PER_VISIBLE_TOKEN = 2.22

/**
 * Fills `think` on every turn. The proxy's count wins when it has one, then
 * the per-message usage (both CLIs' transcripts carry it). Only when neither
 * has it is each phase's `result` total spread over that phase's turns, by the
 * part of each turn's output its visible content does not explain.
 */
function fillThinking(
  turns: Turn[],
  phases: PhaseRun[],
  proxyThinking: Map<string, number> | null,
): NonNullable<RunResult['thinkSource']> {
  if (proxyThinking && turns.some(t => proxyThinking.has(t.id))) {
    for (const t of turns) t.think = proxyThinking.get(t.id) ?? t.think ?? 0
    return 'proxy'
  }
  if (turns.some(t => t.think !== null)) {
    for (const t of turns) t.think ??= 0
    return 'message'
  }
  let spread = false
  for (const p of phases) {
    const phaseTurns = turns.filter(t => t.phase === p.phase)
    if (p.thinkingTokens === null || !phaseTurns.length) continue
    spread = true
    const est = phaseTurns.map(t => Math.max(0, t.out - t.visibleChars / CHARS_PER_VISIBLE_TOKEN))
    const sum = est.reduce((a, b) => a + b, 0)
    phaseTurns.forEach((t, i) => {
      t.think = sum > 0 ? (p.thinkingTokens! * est[i]!) / sum : p.thinkingTokens! / phaseTurns.length
    })
  }
  for (const t of turns) t.think ??= 0
  return spread ? 'phase-spread' : 'none'
}

function collectResults(events: Json[], results: Map<string, { text: string; isError: boolean }>): void {
  for (const e of events) {
    if (e.type !== 'user' || !isRecord(e.message)) continue
    for (const block of blocksOf(e.message.content)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      if (results.has(block.tool_use_id)) continue
      results.set(block.tool_use_id, { text: contentText(block.content), isError: block.is_error === true })
    }
  }
}

function analyzeSession(
  streams: Json[][],
  phase2Ids: Set<string>,
  transcript: Json[] | null,
): { turns: Turn[]; calls: Call[]; source: string } {
  const rows = new Map<string, Row>()
  const order: string[] = []
  const results = new Map<string, { text: string; isError: boolean }>()
  // The transcript first: it is the one source that holds the whole session in
  // order, both processes included. The streams then fill in what it lacks.
  if (transcript) {
    collectRows(transcript, rows, order)
    collectResults(transcript, results)
  }
  for (const events of streams) {
    collectRows(events, rows, order)
    collectResults(events, results)
  }
  const boundary = order.findIndex(id => phase2Ids.has(id))

  const turns: Turn[] = []
  const calls: Call[] = []
  order.forEach((id, i) => {
    const row = rows.get(id)!
    const phase: Phase = boundary >= 0 && i >= boundary ? 2 : 1
    let resultChars = 0
    for (const [useId, use] of row.toolUses) {
      const result = results.get(useId) ?? { text: '', isError: false }
      resultChars += result.text.length
      calls.push({
        turn: i + 1,
        phase,
        name: use.name,
        input: use.input,
        chars: result.text.length,
        isError: result.isError,
        refused: HARNESS_MESSAGE_RE.test(result.text),
        ...(result.isError && SERVED_REFUSAL_RE.test(result.text) ? { served: true } : {}),
        ...(use.name === 'Bash' ? { text: result.text } : {}),
      })
    }
    const usage: Usage = { in: row.in, out: row.out, cR: row.cR, cW: row.cW, cW5m: row.cW5m, cW1h: row.cW1h }
    const prev = turns[i - 1]
    turns.push({
      ...usage,
      n: i + 1,
      phase,
      id,
      model: row.model,
      ctx: row.in + row.cR + row.cW,
      lost: prev ? Math.max(0, prev.cR + prev.cW - row.cR) : null,
      tools: [...row.toolUses.values()].map(t => t.name),
      resultChars,
      think: row.think,
      visibleChars: visibleCharsOf(row),
    })
  })
  return { turns, calls, source: transcript ? 'transcript+stream' : 'stream only' }
}

function emptySubagents(): SubagentUsage {
  return { files: 0, turns: 0, usage: zeroUsage(), costUsd: 0, models: [] }
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...jsonlFiles(path))
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/** Every sub-agent / fork transcript under `<project>/<session>/`, both CLIs' layout. */
function subagentUsage(sessionDir: string, archiveDir: string): SubagentUsage {
  const files = jsonlFiles(sessionDir)
  const acc = emptySubagents()
  const models = new Set<string>()
  for (const file of files) {
    const rows = new Map<string, Row>()
    const order: string[] = []
    collectRows(parseJsonl(readFileSync(file, 'utf8')) as Json[], rows, order)
    for (const id of order) {
      const row = rows.get(id)!
      addUsage(acc.usage, row)
      acc.costUsd += costOf(row.model, row)
      acc.turns++
      models.add(row.model)
    }
    mkdirSync(archiveDir, { recursive: true })
    copyFileSync(file, join(archiveDir, file.slice(sessionDir.length + 1).replaceAll('/', '__')))
  }
  return { ...acc, files: files.length, models: [...models] }
}

// ---------------------------------------------------------------------------
// Bash: markers, and the replay corpus
// ---------------------------------------------------------------------------

const BASH_MARKER_OPEN_RE = /^<bash-output-(filtered|rewritten)\b([^>]*)>/
const LINES_ATTR_RE = /\blines="(\d+)\/(\d+)"/
const REDUCTION_ATTR_RE = /\breduction="(\d+)%"/
const UPSTREAM_WRAPPER_RE = /^<(persisted-output|tool-result-summary)[\s>]/
const HARD_CAP_RE = /\n\n\.\.\. \[\d+ lines truncated\] \.\.\.$/
const EXIT_CODE_RE = /^Exit code (\d+)\n/
/** Same set `extract-bash-corpus.ts` drops: text the command never produced. */
const HARNESS_MESSAGE_RE =
  /^(?:<tool_use_error>|Permission (?:for this action|to use \w+) has been denied|Plan mode is active|\[Request interrupted)/

type BashInfo = {
  command: string
  chars: number
  isError: boolean
  refused: boolean
  marker: 'filtered' | 'rewritten' | 'tool-result-summary' | 'persisted-output' | null
  lines: [number, number] | null
  reductionPct: number | null
  /** Pre-filter size recovered from `reduction=`, when the marker carries one. */
  rawChars: number
}

function bashInfo(call: Call): BashInfo {
  const text = call.text ?? ''
  const command = typeof call.input.command === 'string' ? call.input.command.trim() : ''
  const body = text.replace(EXIT_CODE_RE, '')
  const open = BASH_MARKER_OPEN_RE.exec(body)
  const upstream = UPSTREAM_WRAPPER_RE.exec(body)
  const lines = open ? LINES_ATTR_RE.exec(open[2]!) : null
  const reduction = open ? REDUCTION_ATTR_RE.exec(open[2]!) : null
  const reductionPct = reduction ? Number(reduction[1]) : null
  return {
    command,
    chars: text.length,
    isError: call.isError,
    refused: HARNESS_MESSAGE_RE.test(text),
    marker: open ? (open[1] as 'filtered' | 'rewritten') : upstream ? (upstream[1] as BashInfo['marker']) : null,
    lines: lines ? [Number(lines[1]), Number(lines[2])] : null,
    reductionPct,
    rawChars:
      reductionPct !== null && reductionPct > 0 && reductionPct < 100
        ? Math.round(text.length / (1 - reductionPct / 100))
        : text.length,
  }
}

/** `CorpusEntry` rows (scripts/bench/tokens/transcriptCorpus.ts) for the replay test. */
function writeReplayCorpus(configDir: string, calls: Call[]): number {
  const entries = calls
    .filter(c => c.name === 'Bash')
    .flatMap(c => {
      const command = typeof c.input.command === 'string' ? c.input.command.trim() : ''
      const raw = c.text ?? ''
      if (!command || raw === '' || HARNESS_MESSAGE_RE.test(raw)) return []
      const exit = EXIT_CODE_RE.exec(raw)
      const text = exit ? raw.slice(exit[0].length) : raw
      return [
        {
          command,
          text,
          chars: text.length,
          isError: c.isError,
          exitCode: exit ? Number(exit[1]) : null,
          alreadyFiltered: BASH_MARKER_OPEN_RE.test(text),
          truncatedUpstream: UPSTREAM_WRAPPER_RE.test(text),
          hardCapped: HARD_CAP_RE.test(text),
        },
      ]
    })
  const dir = join(configDir, 'bench', 'bash-corpus')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'corpus.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'))
  return entries.length
}

function runBashReplay(configDir: string): string {
  const r = spawnSync('bun', ['test', REPLAY_TEST], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, CLAUDIN_CONFIG_DIR: configDir },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // Keep the report, drop bun's own banner, file header and pass/fail footer.
  const start = out.indexOf('corpus:')
  const body = start >= 0 ? out.slice(start) : out
  const end = body.search(/\n\S*measure-bash-filter-replay\.test\.ts:|\n\s*\(pass\)|\n\s*\d+ pass\b/)
  return (end >= 0 ? body.slice(0, end) : body).trim()
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const TEST_CMD_RE = /\bbun (?:run )?test\b|\bnpm (?:run )?test\b/
const GIT_CMD_RE = /(?:^|&&|;|\|)\s*git\s/

type Metrics = {
  turns: number
  turnsP1: number
  turnsP2: number
  toolCalls: number
  firstCtx: number
  peakCtx: number
  endCtx: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  cacheWrite5m: number
  reusePct: number
  lost: number
  breaks: number
  resumeReadPct: number
  resumeWrite: number
  subagentTokens: number
  subagentCost: number
  estCost: number
  costOutput: number
  costInput: number
  costRead: number
  costWrite: number
  costResumeWrite: number
  thinking: number
  resentOut: number
  costThinking: number
  costResent: number
  costVisible: number
  costPrefix: number
  costResults: number
  costSplitGap: number
  cliCost: number
  resultChars: number
  bashCalls: number
  bashChars: number
  testRuns: number
  gitOps: number
  reads: number
  distinctReads: number
  edits: number
  errors: number
  refusals: number
  servedRefusals: number
  resubmits: number
  resubmitErrors: number
  wallSec: number
  hiddenPass: number
  hiddenTotal: number
}

/** `apply_patch` is the patch tool's wire name before 2026-09-24; replays span both. */
const PATCH_TOOLS = new Set(['apply_patch', 'Patch'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', ...PATCH_TOOLS, 'NotebookEdit', 'Rename'])
/** A read-gate refusal that carried the lines it refused over (servedRegion.ts). */
const SERVED_REFUSAL_RE = /now count as read/
/** The patch tool's reference to the patch refused one call earlier (patchFormat.ts). */
const isResubmit = (c: Call) => PATCH_TOOLS.has(c.name) && String(c.input.patchText ?? '').trim() === '*** Resubmit'

/**
 * `total_cost_usd` means different things after `--resume`: claude reports the
 * whole session again, claudin only the new process. Whichever reading agrees
 * with the priced timeline is the one this CLI meant.
 */
function cliSessionCost(r: RunResult, estimate: number): { usd: number; cumulative: boolean } {
  const costs = r.phases.map(p => p.cliCostUsd ?? 0)
  const summed = costs.reduce((a, b) => a + b, 0)
  const last = costs.at(-1) ?? 0
  const cumulative = costs.length > 1 && Math.abs(last - estimate) < Math.abs(summed - estimate)
  return { usd: cumulative ? last : summed, cumulative }
}

type CostSplit = {
  thinking: number
  resent: number
  visible: number
  prefix: number
  results: number
  /** Priced minus the parts: 0 on an append-only session, the rewrite when a cache broke. */
  gap: number
  resentOut: number
}

/**
 * The main thread's priced cost by what it paid for, each token priced where it
 * first entered the context: its write there (or uncached input), then a read
 * on every later call. A turn's output enters the next call's context, thinking
 * included; the rest of that growth is tool results and reminders.
 */
function costSplit(r: RunResult): CostSplit {
  const s: CostSplit = { thinking: 0, resent: 0, visible: 0, prefix: 0, results: 0, gap: 0, resentOut: 0 }
  const turns = r.turns
  const T = turns.length
  if (!T) return s
  const write = (t: Turn) => costOf(t.model, { ...zeroUsage(), in: t.in, cW: t.cW, cW5m: t.cW5m, cW1h: t.cW1h })
  const readsAfter = (i: number) => {
    let price = 0
    for (let k = i + 1; k < T; k++) price += priceOf(turns[k]!.model).read
    return price / 1e6
  }
  /** Per token, for what first entered at call i (i ≥ 1). */
  const enter = (i: number): number => {
    if (i <= 0 || i >= T) return 0
    const grew = turns[i]!.ctx - turns[i - 1]!.ctx
    return (grew > 0 ? write(turns[i]!) / grew : 0) + readsAfter(i)
  }
  const t0 = turns[0]!
  s.prefix = (t0.cR * priceOf(t0.model).read) / 1e6 + write(t0) + t0.ctx * readsAfter(0)
  const callsByTurn = new Map<number, Call[]>()
  for (const c of r.calls) callsByTurn.set(c.turn, [...(callsByTurn.get(c.turn) ?? []), c])
  const edits = (n: number) => (callsByTurn.get(n) ?? []).filter(c => EDIT_TOOLS.has(c.name))
  for (let i = 0; i < T; i++) {
    const t = turns[i]!
    const next = turns[i + 1]
    const carried = next ? Math.min(t.out, Math.max(0, next.ctx - t.ctx)) : 0
    const carry = next && t.out > 0 ? (enter(i + 1) * carried) / t.out : 0
    const perToken = priceOf(t.model).out / 1e6 + carry
    const think = Math.min(t.think ?? 0, t.out)
    const visible = t.out - think
    s.thinking += think * perToken
    if (edits(t.n).length > 0 && edits(t.n - 1).some(c => c.refused || c.isError)) {
      s.resent += visible * perToken
      s.resentOut += visible
    } else {
      s.visible += visible * perToken
    }
    if (i > 0) {
      const grew = t.ctx - turns[i - 1]!.ctx
      s.results += Math.max(0, grew - Math.min(turns[i - 1]!.out, Math.max(0, grew))) * enter(i)
    }
  }
  const priced = turns.reduce((a, t) => a + costOf(t.model, t), 0)
  s.gap = priced - (s.thinking + s.resent + s.visible + s.prefix + s.results)
  return s
}

function metricsOf(r: RunResult): Metrics {
  const main = zeroUsage()
  let estCost = 0
  // The same price split into what it paid for, so a gap between arms can be
  // attributed: the uncached tail, the reads, the writes, the resume.
  const parts = { output: 0, input: 0, read: 0, write: 0 }
  for (const t of r.turns) {
    addUsage(main, t)
    estCost += costOf(t.model, t)
    parts.output += costOf(t.model, { ...zeroUsage(), out: t.out })
    parts.input += costOf(t.model, { ...zeroUsage(), in: t.in })
    parts.read += costOf(t.model, { ...zeroUsage(), cR: t.cR })
    parts.write += costOf(t.model, { ...zeroUsage(), cW: t.cW, cW5m: t.cW5m, cW1h: t.cW1h })
  }
  const ctxs = r.turns.map(t => t.ctx)
  const p1 = r.turns.filter(t => t.phase === 1)
  const p2 = r.turns.filter(t => t.phase === 2)
  const resumeTurn = p2[0]
  const beforeResume = p1.at(-1)
  const resumePrefix = beforeResume ? beforeResume.cR + beforeResume.cW : 0
  const bash = r.calls.filter(c => c.name === 'Bash').map(bashInfo)
  const readPaths = r.calls.filter(c => c.name === 'Read').map(c => String(c.input.file_path ?? ''))
  const lastGrade = r.grades.at(-1)
  const denominator = main.cR + main.cW + main.in
  const split = costSplit(r)
  return {
    turns: r.turns.length,
    turnsP1: p1.length,
    turnsP2: p2.length,
    toolCalls: r.calls.length,
    firstCtx: ctxs[0] ?? 0,
    peakCtx: ctxs.length ? Math.max(...ctxs) : 0,
    endCtx: ctxs.at(-1) ?? 0,
    input: main.in,
    output: main.out,
    cacheRead: main.cR,
    cacheWrite: main.cW,
    cacheWrite1h: main.cW1h,
    cacheWrite5m: main.cW5m,
    reusePct: denominator ? (main.cR / denominator) * 100 : 0,
    lost: r.turns.reduce((a, t) => a + (t.lost ?? 0), 0),
    breaks: r.turns.filter(t => (t.lost ?? 0) > BREAK_TOKENS).length,
    resumeReadPct: resumeTurn && resumePrefix ? (resumeTurn.cR / resumePrefix) * 100 : 0,
    resumeWrite: resumeTurn?.cW ?? 0,
    subagentTokens: r.subagents.usage.in + r.subagents.usage.out + r.subagents.usage.cR + r.subagents.usage.cW,
    subagentCost: r.subagents.costUsd,
    estCost: estCost + r.subagents.costUsd,
    costOutput: parts.output,
    costInput: parts.input,
    costRead: parts.read,
    costWrite: parts.write,
    costResumeWrite: resumeTurn
      ? costOf(resumeTurn.model, { ...zeroUsage(), cW: resumeTurn.cW, cW5m: resumeTurn.cW5m, cW1h: resumeTurn.cW1h })
      : 0,
    thinking: r.turns.reduce((a, t) => a + (t.think ?? 0), 0),
    resentOut: split.resentOut,
    costThinking: split.thinking,
    costResent: split.resent,
    costVisible: split.visible,
    costPrefix: split.prefix,
    costResults: split.results,
    costSplitGap: split.gap,
    cliCost: cliSessionCost(r, estCost + r.subagents.costUsd).usd,
    resultChars: r.calls.reduce((a, c) => a + c.chars, 0),
    bashCalls: bash.length,
    bashChars: bash.reduce((a, b) => a + b.chars, 0),
    testRuns: r.calls.filter(
      c => c.name === 'RunTests' || (c.name === 'Bash' && TEST_CMD_RE.test(String(c.input.command ?? ''))),
    ).length,
    gitOps: r.calls.filter(c => c.name === 'Git' || (c.name === 'Bash' && GIT_CMD_RE.test(String(c.input.command ?? ''))))
      .length,
    reads: readPaths.length,
    distinctReads: new Set(readPaths).size,
    edits: r.calls.filter(c => EDIT_TOOLS.has(c.name)).length,
    errors: r.calls.filter(c => c.isError && !c.refused).length,
    refusals: r.calls.filter(c => c.refused).length,
    servedRefusals: r.calls.filter(c => EDIT_TOOLS.has(c.name) && c.served).length,
    resubmits: r.calls.filter(isResubmit).length,
    resubmitErrors: r.calls.filter(c => isResubmit(c) && c.isError).length,
    wallSec: r.phases.reduce((a, p) => a + p.wallMs, 0) / 1000,
    hiddenPass: lastGrade ? lastGrade.hidden.reduce((a, h) => a + h.pass, 0) : 0,
    hiddenTotal: lastGrade ? lastGrade.hidden.reduce((a, h) => a + h.pass + h.fail, 0) : 0,
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtK(n: number): string {
  const a = Math.abs(n)
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (a >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

const fmtInt = (n: number): string => String(Math.round(n))
const fmtUsd = (n: number): string => `$${n.toFixed(3)}`
const fmtPct = (n: number): string => `${n.toFixed(1)}%`

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(' | ')} |`
  return [line(headers), `|${widths.map(w => '-'.repeat(w + 2)).join('|')}|`, ...rows.map(line)].join('\n')
}

function toolSummary(names: string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(' ')
}

function turnTable(r: RunResult): string {
  const rows = r.turns.map((t, i) => {
    const prev = r.turns[i - 1]
    const lost = t.lost ?? 0
    return [
      String(t.n),
      String(t.phase),
      fmtK(t.ctx),
      prev ? `${t.ctx - prev.ctx >= 0 ? '+' : ''}${fmtK(t.ctx - prev.ctx)}` : '',
      fmtK(t.cR),
      fmtK(t.cW) + (t.cW && t.cW1h === t.cW ? '' : t.cW5m ? ' (5m)' : ''),
      fmtK(t.in),
      fmtK(t.out),
      t.think === null ? '' : fmtK(t.think),
      t.lost === null ? '' : lost > BREAK_TOKENS ? `**${fmtK(lost)}**` : fmtK(lost),
      fmtK(t.resultChars),
      toolSummary(t.tools),
    ]
  })
  return table(['#', 'ph', 'context', 'Δ', 'cache read', 'cache write', 'in', 'out', 'think', 'lost', 'result ch', 'tools'], rows)
}

type MetricRow = [label: string, key: keyof Metrics, fmt: (n: number) => string]

const METRIC_ROWS: MetricRow[] = [
  ['turns (main thread)', 'turns', fmtInt],
  ['  phase 1', 'turnsP1', fmtInt],
  ['  phase 2 (resumed)', 'turnsP2', fmtInt],
  ['tool calls', 'toolCalls', fmtInt],
  ['first-turn context', 'firstCtx', fmtK],
  ['peak context', 'peakCtx', fmtK],
  ['end context', 'endCtx', fmtK],
  ['input (uncached)', 'input', fmtK],
  ['output', 'output', fmtK],
  ['  of which thinking (API)', 'thinking', fmtK],
  ['cache read', 'cacheRead', fmtK],
  ['cache write', 'cacheWrite', fmtK],
  ['  of which 1h TTL', 'cacheWrite1h', fmtK],
  ['  of which 5m TTL', 'cacheWrite5m', fmtK],
  ['cache reuse (read / all input)', 'reusePct', fmtPct],
  ['lost prefix tokens (Σ)', 'lost', fmtK],
  [`cache breaks (> ${BREAK_TOKENS} lost)`, 'breaks', fmtInt],
  ['resume: prefix read back', 'resumeReadPct', fmtPct],
  ['resume: cache write on turn 1', 'resumeWrite', fmtK],
  ['sub-agent tokens (all kinds)', 'subagentTokens', fmtK],
  ['est. cost, one price table', 'estCost', fmtUsd],
  ['  output', 'costOutput', fmtUsd],
  ['  uncached input', 'costInput', fmtUsd],
  ['  cache read', 'costRead', fmtUsd],
  ['  cache write', 'costWrite', fmtUsd],
  ['    of which the resume turn', 'costResumeWrite', fmtUsd],
  ['  of which sub-agents', 'subagentCost', fmtUsd],
  ['main thread by source: thinking', 'costThinking', fmtUsd],
  ['  patch re-sent after a refused edit', 'costResent', fmtUsd],
  ['  other visible output', 'costVisible', fmtUsd],
  ['  first request (prefix), re-read every call', 'costPrefix', fmtUsd],
  ['  tool results and reminders', 'costResults', fmtUsd],
  ['  unattributed (a cache break)', 'costSplitGap', fmtUsd],
  ['re-sent output tokens', 'resentOut', fmtK],
  ['CLI-reported cost (session)', 'cliCost', fmtUsd],
  ['tool result chars', 'resultChars', fmtK],
  ['Bash calls', 'bashCalls', fmtInt],
  ['Bash result chars', 'bashChars', fmtK],
  ['test runs (Bash or RunTests)', 'testRuns', fmtInt],
  ['git ops (Bash or Git)', 'gitOps', fmtInt],
  ['Read calls', 'reads', fmtInt],
  ['  distinct files read', 'distinctReads', fmtInt],
  ['edit calls', 'edits', fmtInt],
  ['tool errors (incl. failing tests)', 'errors', fmtInt],
  ['harness refusals (redirects, gates)', 'refusals', fmtInt],
  ['  edits refused with the lines served', 'servedRefusals', fmtInt],
  ['patches resubmitted by reference', 'resubmits', fmtInt],
  ['  of which failed', 'resubmitErrors', fmtInt],
  ['wall time (s)', 'wallSec', fmtInt],
  ['hidden acceptance passed', 'hiddenPass', fmtInt],
]

function comparisonTable(runs: RunResult[], arms: Arm[]): string {
  const byArm = new Map(arms.map(a => [a, runs.filter(r => r.arm === a).map(metricsOf)]))
  const multi = runs.length > arms.length
  const [base, ...others] = arms
  const rows = METRIC_ROWS.map(([label, key, fmt]) => {
    const cells = arms.map(a => {
      const values = byArm.get(a)!.map(m => m[key])
      if (!values.length) return '—'
      const med = fmt(median(values))
      return multi ? `${med} [${fmt(Math.min(...values))}–${fmt(Math.max(...values))}]` : med
    })
    // Every other arm against the first one, with the range verdict: only a
    // SEPARATED row supports a claim at this rep count.
    const verdicts = others.map(other => {
      const a = byArm.get(base!)!.map(m => m[key])
      const b = byArm.get(other)!.map(m => m[key])
      if (!a.length || !b.length) return ''
      const ma = median(a)
      const mb = median(b)
      const d = ma === 0 ? (mb === 0 ? '0%' : 'n/a') : `${mb >= ma ? '+' : ''}${(((mb - ma) / ma) * 100).toFixed(0)}%`
      const overlap = Math.min(...a) <= Math.max(...b) && Math.min(...b) <= Math.max(...a)
      return multi ? `${d} ${overlap ? '(overlap)' : 'SEPARATED'}` : d
    })
    return [label, ...cells, ...verdicts]
  })
  const head = ['metric (median' + (multi ? ' [min–max]' : '') + ')', ...arms]
  for (const other of others) head.push(`Δ ${other} vs ${base}`)
  return table(head, rows)
}

function gradeTable(runs: RunResult[]): string {
  const rows = runs.map(r => {
    const g1 = r.grades[0]
    const g2 = r.grades[1]
    const hid = (g: Grade | undefined) => (g ? g.hidden.map(h => `${h.pass}/${h.pass + h.fail}`).join('+') : '—')
    const tests = (g: Grade | undefined) => (g ? `${g.tests.pass}/${g.tests.pass + g.tests.fail}` : '—')
    // API calls, not the CLI's num_turns: claudin counts every tool-result
    // message there (QueryEngine.ts `turnCount++` per user message), so a turn
    // with ten parallel Reads reports as ten.
    const phase = (p: PhaseRun | undefined) =>
      p ? `${p.subtype ?? `exit ${p.exitCode}`} ${p.messageIds.length} calls (num_turns ${p.numTurns ?? '?'})` : '—'
    return [
      `${r.arm} r${r.rep}`,
      phase(r.phases[0]),
      tests(g1),
      hid(g1),
      phase(r.phases[1]),
      tests(g2),
      hid(g2),
      g2?.git ? `${g2.git.commits - 1} "${g2.git.subject.slice(0, 48)}"` : '—',
      g2?.git ? (g2.git.trailer === undefined ? '?' : g2.git.trailer ? '**yes**' : 'no') : '—',
      g2?.git ? (g2.git.clean ? 'clean' : g2.git.status.split('\n').length + ' dirty') : '—',
    ]
  })
  return table(
    ['run', 'P1 result', 'P1 tests', 'P1 hidden', 'P2 result', 'P2 tests', 'P2 hidden', 'new commits', 'AI trailer', 'tree'],
    rows,
  )
}

/** Who committed with an AI footer — and who was graded before the check, which is unknown rather than clean. */
function trailerNotes(runs: RunResult[]): string[] {
  const runsWhere = (trailer: boolean | undefined) =>
    runs
      .filter(r => {
        const git = r.grades[1]?.git
        return git ? git.trailer === trailer : false
      })
      .map(r => `${r.arm} r${r.rep}`)
  const flagged = runsWhere(true)
  const unknown = runsWhere(undefined)
  return [
    ...(flagged.length ? [`**AI attribution trailer** in the commits of ${flagged.join(', ')}.`, ''] : []),
    ...(unknown.length ? [`AI trailer not recorded for ${unknown.join(', ')}: their results.json predates the check.`, ''] : []),
  ]
}

function toolTable(runs: RunResult[], arm: Arm): string {
  const armRuns = runs.filter(r => r.arm === arm)
  const stats = new Map<string, { calls: number; chars: number; errors: number }>()
  for (const r of armRuns) {
    for (const c of r.calls) {
      const s = stats.get(c.name) ?? { calls: 0, chars: 0, errors: 0 }
      s.calls++
      s.chars += c.chars
      if (c.isError) s.errors++
      stats.set(c.name, s)
    }
  }
  const n = Math.max(1, armRuns.length)
  const rows = [...stats]
    .sort((a, b) => b[1].chars - a[1].chars)
    .map(([name, s]) => [name, (s.calls / n).toFixed(1), fmtK(s.chars / n), fmtK(s.chars / Math.max(1, s.calls)), (s.errors / n).toFixed(1)])
  return table(['tool (mean per run)', 'calls', 'result chars', 'chars/call', 'errors'], rows)
}

function bashSection(runs: RunResult[], arm: Arm): string {
  const infos = runs.filter(r => r.arm === arm).flatMap(r => r.calls.filter(c => c.name === 'Bash').map(bashInfo))
  if (!infos.length) return `No Bash calls.`
  const count = (m: BashInfo['marker']) => infos.filter(i => i.marker === m).length
  const filtered = infos.filter(i => i.marker === 'filtered')
  const lines: string[] = [
    `${infos.length} calls, ${infos.filter(i => i.refused).length} refused by the harness, ` +
      `${infos.filter(i => i.isError && !i.refused).length} failed, ${fmtK(infos.reduce((a, i) => a + i.chars, 0))} chars returned.`,
    `Markers: ${count('filtered')} filtered, ${count('rewritten')} rewritten, ${count('tool-result-summary')} summarized, ` +
      `${count('persisted-output')} persisted, ${infos.filter(i => !i.marker && !i.refused).length} passed through untouched.`,
  ]
  if (filtered.length) {
    const raw = filtered.reduce((a, i) => a + i.rawChars, 0)
    const kept = filtered.reduce((a, i) => a + i.chars, 0)
    lines.push(`Filtered calls: ${fmtK(raw)} chars before → ${fmtK(kept)} after (${fmtPct(((raw - kept) / Math.max(1, raw)) * 100)} removed).`)
  }
  const top = [...infos].sort((a, b) => b.chars - a.chars).slice(0, 12)
  lines.push(
    '',
    table(
      ['command (largest 12)', 'chars', 'marker', 'lines', 'refused'],
      top.map(i => [
        i.command.replace(/\s+/g, ' ').slice(0, 70),
        fmtK(i.chars),
        i.marker ? `${i.marker}${i.reductionPct !== null ? ` -${i.reductionPct}%` : ''}` : '',
        i.lines ? `${i.lines[0]}/${i.lines[1]}` : '',
        i.refused ? 'yes' : '',
      ]),
    ),
  )
  return lines.join('\n')
}

function cacheEvents(r: RunResult): string {
  const events = r.turns.filter(t => (t.lost ?? 0) > BREAK_TOKENS)
  const p2 = r.turns.find(t => t.phase === 2)
  const lines = events.map(
    t => `- turn ${t.n} (phase ${t.phase}): ${fmtK(t.lost ?? 0)} of the previous prefix not read back; wrote ${fmtK(t.cW)}, context ${fmtK(t.ctx)}`,
  )
  if (p2) {
    const prev = r.turns[p2.n - 2]
    const prefix = prev ? prev.cR + prev.cW : 0
    lines.push(
      `- resume (turn ${p2.n}): read ${fmtK(p2.cR)} of the ${fmtK(prefix)} cached before the new process, wrote ${fmtK(p2.cW)}`,
    )
  }
  return lines.length ? lines.join('\n') : '- none'
}

function sideModels(r: RunResult): string {
  const mains = new Set(r.turns.map(t => t.model))
  const parts: string[] = []
  for (const p of r.phases) {
    for (const [model, u] of Object.entries(p.modelUsage)) {
      if (mains.has(model)) continue
      parts.push(`P${p.phase} ${model}: $${num(u.costUSD).toFixed(4)} (${fmtK(num(u.inputTokens) + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens))} in, ${fmtK(num(u.outputTokens))} out)`)
    }
  }
  return parts.length ? parts.join('; ') : 'none'
}

function report(runs: RunResult[], meta: Meta, replayBash: boolean): string {
  const arms = meta.arms.filter(a => runs.some(r => r.arm === a))
  const out: string[] = []
  out.push(
    `# session-cache-ab — ${meta.started}`,
    '',
    `- model \`${meta.model}\`, effort \`${meta.effort}\`, turn caps ${meta.maxTurns.join(' + ')}, gap between phases ${meta.gapSec}s, reps ${meta.reps}`,
    ...Object.entries(meta.versions).map(([k, v]) => `- ${k}: ${v}`),
    ...Object.entries(meta.armEnv ?? {})
      .filter(([, env]) => Object.keys(env).length > 0)
      .map(([k, env]) => `- ${k} runs with ${Object.entries(env).map(([n, v]) => `\`${n}=${v}\``).join(' ')}`),
    ...Object.entries(meta.armArgs ?? {})
      .filter(([, extra]) => extra.length > 0)
      .map(([k, extra]) => `- ${k} runs with \`${extra.join(' ')}\``),
    ...(meta.proxy ? ['- every arm went through the recording proxy (`wire-proxy.ts`, logs in `proxy/`)'] : []),
    ...(meta.proxyDisplay ? [`- the proxy set \`thinking.display: "${meta.proxyDisplay}"\` on every request of every arm`] : []),
    `- run dir: \`${meta.runDir}\` (workspaces, streams, archived transcripts)`,
    `- pristine project: ${meta.baselineTests} tests`,
    '',
    '## Grades',
    '',
    gradeTable(runs),
    '',
    ...trailerNotes(runs),
    'A token delta between runs that did not do the same work compares different amounts of work.',
    '',
    '## Totals',
    '',
    comparisonTable(runs, arms),
    '',
    '`lost` = tokens the previous request had cached (read + written) that this request did not read back. ' +
      'On an append-only session it is ~0 every turn; a positive value is a prefix the CLI rewrote.',
    '',
    '`by source` prices each token where it first entered the context — generated, written once, read by every ' +
      'later call — so the rows add up to the main thread\'s priced cost. Thinking is the API\'s count per message ' +
      '(the per-run `thinking from` line says where it was read).',
    '',
  )
  for (const rep of [...new Set(runs.map(r => r.rep))]) {
    const repRuns = arms.map(a => runs.find(r => r.arm === a && r.rep === rep))
    const depth = Math.max(0, ...repRuns.map(r => r?.turns.length ?? 0))
    const cell = (r: RunResult | undefined, i: number) => {
      const t = r?.turns[i]
      return t ? `${fmtK(t.ctx)} (r ${fmtK(t.cR)} / w ${fmtK(t.cW)} / in ${fmtK(t.in)})${t.phase === 2 && r!.turns[i - 1]?.phase === 1 ? ' ← resume' : ''}` : ''
    }
    out.push(
      `## Context per turn, side by side — rep ${rep}`,
      '',
      table(
        ['turn', ...arms.map(a => `${a}: context (read / write / uncached)`)],
        Array.from({ length: depth }, (_, i) => [String(i + 1), ...repRuns.map(r => cell(r, i))]),
      ),
      '',
    )
  }
  for (const r of runs) {
    const m = metricsOf(r)
    const cli = cliSessionCost(r, m.estCost)
    out.push(
      `## ${r.arm} rep ${r.rep} — per turn`,
      '',
      `session \`${r.sessionId}\`, usage from ${r.usageSource}, model ${r.model}, ` +
        `sub-agents: ${r.subagents.files} transcript(s), ${r.subagents.turns} turns, ${fmtUsd(r.subagents.costUsd)}; ` +
        `side models: ${sideModels(r)}; tools at init: ${r.phases.map(p => p.initTools ?? '?').join(' / ')}; ` +
        `thinking from ${r.thinkSource ?? 'none'}; ` +
        `CLI cost ${r.phases.map(p => `P${p.phase} ${fmtUsd(p.cliCostUsd ?? 0)}`).join(' / ')}` +
        (cli.cumulative ? ' (the resumed process re-reports the whole session)' : '') +
        `, priced here ${fmtUsd(m.estCost)}`,
      '',
      turnTable(r),
      '',
      'Cache events:',
      cacheEvents(r),
      '',
    )
    const dirty = r.gitStatus.map((s, i) => (s ? `after P${i + 1}: ${s.split('\n').join(', ')}` : '')).filter(Boolean)
    if (dirty.length) out.push(`Working tree: ${dirty.join(' | ')}`, '')
  }
  out.push('## Tools', '')
  for (const arm of arms) out.push(`### ${arm}`, '', toolTable(runs, arm), '')
  out.push('## Bash', '')
  for (const arm of arms) out.push(`### ${arm}`, '', bashSection(runs, arm), '')
  if (replayBash) {
    out.push(
      '## Bash filter replay',
      '',
      `Each arm's recorded Bash output replayed through today's filter (\`${REPLAY_TEST}\`). ` +
        "For claude this is \"what the filter would have done\"; for claudindev the marked calls show up as already done in production.",
      '',
    )
    for (const arm of arms) {
      const dir = join(meta.runDir, `bash-replay-${arm}`)
      const n = writeReplayCorpus(dir, runs.filter(r => r.arm === arm).flatMap(r => r.calls))
      out.push(`### ${arm} (${n} calls)`, '', '```', n ? runBashReplay(dir) : 'no replayable Bash calls', '```', '')
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Dry run — validates the fixture and the grader without spending a token.
// ---------------------------------------------------------------------------

function dryRun(): void {
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  const grader = makeGrader(dir)
  const pristine = join(dir, 'pristine')
  const solved = join(dir, 'solution')
  makeWorkspace(pristine)
  makeWorkspace(solved)
  materialize(join(FIXTURE, 'solution'), solved)

  const p0 = bunTest(pristine, [])
  const p1 = hiddenRun(grader, pristine, 1)
  const p2 = hiddenRun(grader, pristine, 2)
  const s0 = bunTest(solved, [])
  const s1 = hiddenRun(grader, solved, 1)
  const s2 = hiddenRun(grader, solved, 2)
  // The commit grader, on the same commit twice: plain, then with the footer
  // Claude Code writes. Only the second may be flagged.
  const message = 'feat: bulk tiers, JSON quotes and coupon expiry'
  git(solved, 'add', '-A')
  git(solved, 'commit', '-q', '-m', message)
  const plain = gitGrade(solved)
  git(solved, 'commit', '-q', '--amend', '-m', `${message}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`)
  const signed = gitGrade(solved)
  // The support ticket must describe a real bug: the pristine CLI gives that
  // cart free shipping, the reference solution charges it.
  const ticket = (ws: string) =>
    spawnSync('bun', ['run', join(ws, 'src', 'cli.ts'), 'quote', join(grader, 'cart-threshold-us.json')], {
      cwd: ws,
      encoding: 'utf8',
    }).stdout ?? ''

  const gates: Array<[string, boolean, string]> = [
    ['pristine suite is green', p0.ok && p0.fail === 0 && p0.pass > 0, `${p0.pass} pass / ${p0.fail} fail`],
    ['pristine fails the phase-1 grader', p1.pass === 0 && p1.fail > 0, `${p1.pass}/${p1.pass + p1.fail} pass`],
    ['pristine fails the phase-2 grader', p2.pass === 0 && p2.fail > 0, `${p2.pass}/${p2.pass + p2.fail} pass`],
    ['the ticket reproduces on pristine', /^Shipping +FREE$/m.test(ticket(pristine)), 'Shipping FREE on a $68.38 order'],
    ['the solution fixes the ticket', /^Shipping +\$5\.99$/m.test(ticket(solved)), 'Shipping $5.99'],
    ['the solution keeps the old suite green', s0.ok && s0.fail === 0 && s0.pass === p0.pass, `${s0.pass} pass / ${s0.fail} fail ${s0.failed.join('; ')}`],
    ['the solution passes the phase-1 grader', s1.ok && s1.fail === 0 && s1.pass > 0, `${s1.pass}/${s1.pass + s1.fail} ${s1.failed.join('; ')}`],
    ['the solution passes the phase-2 grader', s2.ok && s2.fail === 0 && s2.pass > 0, `${s2.pass}/${s2.pass + s2.fail} ${s2.failed.join('; ')}`],
    ['both prompts exist', PHASES.every(p => readPrompt(p).length > 200), 'prompts/phase{1,2}.md'],
    ['a plain commit grades conventional, no AI trailer', plain.conventional && plain.trailer === false, `"${plain.subject}"`],
    ["Claude Code's co-author footer is caught", signed.conventional && signed.trailer === true, 'Co-Authored-By: Claude Opus 5.5'],
  ]
  console.log(`dry run in ${dir}\n`)
  console.log(table(['gate', 'ok', 'detail'], gates.map(([g, ok, d]) => [g, ok ? 'yes' : 'NO', d])))
  if (gates.some(([, ok]) => !ok)) process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const a: Args = {
    reps: 1,
    only: null,
    sequential: false,
    model: 'claude-opus-5-5',
    effort: 'high',
    maxTurns: [35, 20],
    budgetUsd: 20,
    gapSec: 0,
    timeoutMs: 45 * 60_000,
    dryRun: false,
    replay: '',
    replayBash: true,
    bins: { claude: 'claude', claudindev: join(REPO_ROOT, 'bin', 'claudin') },
    env: {},
    args: {},
    variants: [],
    proxy: false,
    proxyDisplay: null,
  }
  const variantSpecs: string[] = []
  const armArgSpecs: string[] = []
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--sequential') a.sequential = true
    else if (k === '--proxy') a.proxy = true
    else if (k === '--proxy-display') {
      a.proxy = true
      a.proxyDisplay = v
    }
    else if (k === '--no-bash-replay') a.replayBash = false
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--model') a.model = v
    else if (k === '--effort') a.effort = v
    else if (k === '--max-turns') a.maxTurns = v.split(',').map(Number) as [number, number]
    else if (k === '--budget') a.budgetUsd = Number(v)
    else if (k === '--gap') a.gapSec = Number(v)
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--replay') a.replay = v
    else if (k === '--bin-claude') a.bins.claude = v
    else if (k === '--bin-claudindev') a.bins.claudindev = v
    else if (k === '--variant') variantSpecs.push(v)
    else if (k === '--arm-args') armArgSpecs.push(v)
    else {
      console.error(`unknown argument ${x}`)
      process.exit(2)
    }
  }
  // After the loop, so a --bin-claudindev given later still applies.
  for (const spec of variantSpecs) {
    const colon = spec.indexOf(':')
    const label = colon < 0 ? spec : spec.slice(0, colon)
    const pairs = colon < 0 ? [] : spec.slice(colon + 1).split(',').filter(Boolean)
    a.bins[label] = a.bins.claudindev!
    a.env[label] = Object.fromEntries(pairs.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
    a.variants.push(label)
  }
  for (const spec of armArgSpecs) {
    const colon = spec.indexOf(':')
    if (colon < 1) {
      console.error(`--arm-args wants <label>:<args>, got ${spec}`)
      process.exit(2)
    }
    a.args[spec.slice(0, colon)] = spec.slice(colon + 1).split(/\s+/).filter(Boolean)
  }
  return a
}

function version(bin: string): string {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env: armEnv(), timeout: 30_000 })
  return (r.stdout ?? '').trim() || `(no --version: ${(r.stderr ?? '').trim().slice(0, 80)})`
}

function save(runDir: string, runs: RunResult[], meta: Meta): string {
  const path = join(runDir, 'results.json')
  writeFileSync(path, JSON.stringify({ meta, runs }, null, 1))
  return path
}

/**
 * Rebuild turns and calls from the run's archived streams and transcript, and
 * the thinking from the proxy logs when the run had them, so a results.json
 * written by an older version of this analysis reports every current row. A
 * run whose streams are gone is kept as saved.
 */
function reanalyze(r: RunResult, runDir: string): RunResult {
  const label = `${r.arm}-r${r.rep}`
  const files = PHASES.map(p => join(runDir, `${label}.p${p}.stream.jsonl`))
  if (!files.every(existsSync)) return r
  const streams = files.map(file => parseJsonl(readFileSync(file, 'utf8')) as Json[])
  const transcript = r.transcript && existsSync(r.transcript) ? (parseJsonl(readFileSync(r.transcript, 'utf8')) as Json[]) : null
  const session = analyzeSession(streams, new Set(r.phases.find(p => p.phase === 2)?.messageIds ?? []), transcript)
  const phases = r.phases.map((p, i) => ({
    ...p,
    thinkingTokens: p.thinkingTokens ?? thinkingFromResult(streams[i]?.findLast(e => e.type === 'result')),
  }))
  const proxyDir = join(runDir, 'proxy')
  const proxyThinking = existsSync(proxyDir) ? readProxyThinking(proxyDir, PHASES.map(p => `${label}.p${p}`)) : null
  const thinkSource = fillThinking(session.turns, phases, proxyThinking)
  return { ...r, phases, turns: session.turns, calls: session.calls, thinkSource }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    dryRun()
    return
  }
  if (args.replay) {
    // Several results files merge into one report, so a variant run can be
    // read against the baseline run it was meant to be compared with. A
    // `file@label` suffixes that file's arms (`claudindev@before`), so the same
    // arm from two runs lands in two columns instead of merging into one.
    const files = args.replay.split(',').filter(Boolean)
    const saved = files.map(spec => {
      const [, file = spec, label] = /^(.*\.json)@([^/]+)$/.exec(spec) ?? []
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { meta: Meta; runs: RunResult[] }
      const s = { meta: raw.meta, runs: raw.runs.map(r => reanalyze(r, raw.meta.runDir)) }
      if (!label) return s
      const name = (arm: string) => `${arm}@${label}`
      const rekey = <T>(o: Record<string, T> = {}) =>
        Object.fromEntries(Object.entries(o).map(([k, v]) => [name(k), v]))
      return {
        meta: {
          ...s.meta,
          arms: s.meta.arms.map(name),
          versions: rekey(s.meta.versions),
          armEnv: rekey(s.meta.armEnv),
          armArgs: rekey(s.meta.armArgs),
        },
        runs: s.runs.map(r => ({ ...r, arm: name(r.arm) })),
      }
    })
    const arms = [...new Set(saved.flatMap(s => s.meta.arms))].filter(a => !args.only || args.only.includes(a))
    const selected = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => arms.includes(k)))
    const meta: Meta = {
      ...saved[0]!.meta,
      arms,
      versions: selected(Object.assign({}, ...saved.map(s => s.meta.versions))),
      armEnv: selected(Object.assign({}, ...saved.map(s => s.meta.armEnv ?? {}))),
      armArgs: selected(Object.assign({}, ...saved.map(s => s.meta.armArgs ?? {}))),
      reps: Math.max(...saved.map(s => s.meta.reps)),
    }
    if (args.only) meta.arms.sort((x, y) => args.only!.indexOf(x) - args.only!.indexOf(y))
    const runs = saved.flatMap(s => s.runs).filter(r => meta.arms.includes(r.arm))
    const text = report(runs, meta, args.replayBash)
    writeFileSync(join(meta.runDir, files.length > 1 ? `report-${meta.arms.join('-vs-')}.md` : 'report.md'), text)
    console.log(text)
    return
  }

  const arms = args.only ?? [...ARMS, ...args.variants]
  const unknown = arms.filter(a => !args.bins[a])
  if (unknown.length) {
    console.error(`no binary for ${unknown.join(', ')} — declare a variant with --variant=<label>:<ENV>=<value>`)
    process.exit(2)
  }
  const strayArgs = Object.keys(args.args).filter(label => !args.bins[label])
  if (strayArgs.length) {
    console.error(`--arm-args for an arm that does not exist: ${strayArgs.join(', ')} — declare it with --variant=<label>`)
    process.exit(2)
  }
  if (arms.some(a => args.bins[a] === args.bins.claudindev) && !existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
    console.error('dist/cli.mjs is missing — run `bun run build` first: bin/claudin runs the bundle, not the source.')
    process.exit(1)
  }
  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  const graderDir = makeGrader(runDir)
  const pristine = join(runDir, 'pristine')
  makeWorkspace(pristine)
  const baseline = bunTest(pristine, [])
  if (!baseline.ok) {
    console.error(`the pristine project is not green (${baseline.fail} fail) — run --dry-run`)
    process.exit(1)
  }
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout.trim()
  const meta: Meta = {
    started: new Date().toISOString(),
    runDir,
    model: args.model,
    effort: args.effort,
    maxTurns: args.maxTurns,
    gapSec: args.gapSec,
    reps: args.reps,
    arms,
    versions: Object.fromEntries(
      arms.map(a => [
        a,
        args.bins[a] === args.bins.claudindev
          ? `${version(args.bins[a]!)} @ ${head}${dirty ? ' (src dirty)' : ''}`
          : version(args.bins[a]!),
      ]),
    ),
    armEnv: Object.fromEntries(arms.map(a => [a, args.env[a] ?? {}])),
    armArgs: Object.fromEntries(arms.map(a => [a, args.args[a] ?? []])),
    proxy: args.proxy,
    proxyDisplay: args.proxyDisplay,
    baselineTests: baseline.pass,
  }
  console.log(`session-cache-ab → ${runDir}`)
  for (const [k, v] of Object.entries(meta.versions)) console.log(`  ${k}: ${v}`)

  const proxy = args.proxy
    ? await startWireProxy(join(runDir, 'proxy'), {
        transform: args.proxyDisplay ? thinkingDisplayTransform(args.proxyDisplay) : undefined,
      })
    : null
  if (proxy) console.log(`  recording proxy on 127.0.0.1:${proxy.port} → ${proxy.logDir}`)
  const ctx: RunContext = { args, runDir, graderDir, proxy }
  const runs: RunResult[] = []
  for (let rep = 1; rep <= args.reps; rep++) {
    if (args.sequential) {
      // Rotate who goes first, so the cold prefix is not always the same arm's.
      const order = rep % 2 ? arms : [...arms].reverse()
      for (const arm of order) runs.push(await runArm(arm, rep, ctx))
    } else {
      runs.push(...(await Promise.all(arms.map(arm => runArm(arm, rep, ctx)))))
    }
    save(runDir, runs, meta)
  }
  await proxy?.close()

  const text = report(runs, meta, args.replayBash)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nresults → ${save(runDir, runs, meta)}\nreport  → ${join(runDir, 'report.md')}`)
}

if (import.meta.main) await main()
