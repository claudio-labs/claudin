#!/usr/bin/env bun
/**
 * Git tool A/B — what the tool costs and saves in a real conversation.
 *
 * The replay harness (`git-summarizer-replay.ts`) measures payload against
 * recorded output. It cannot answer the question that decides whether this tool
 * should ship: in a live session, does the model reach for it, does batching
 * collapse the bursts, and does the always-present description cost more than
 * the summaries save.
 *
 * Protocol (fixed by the plan — do not "improve" it):
 *
 *  - ONE run per arm, 15 steps. A single run is noisy; the reporting leans on
 *    the large deltas and prints the raw numbers rather than hiding the noise
 *    behind a median of runs that were never made.
 *  - TWO arms on ONE build, flipping a killswitch. `before` sets
 *    CLAUDIN_DISABLE_GIT_TOOL=1, which drops the tool from the toolset
 *    entirely — so the comparison also prices its description, paid on every
 *    request. Comparing two binaries instead is what made the clip-pin A/B
 *    uncitable.
 *  - Sonnet 5, pinned explicitly. A run that reports another model is thrown
 *    away, not reported.
 *  - A throwaway git repository under the OS temp dir, rebuilt byte-identically
 *    before each arm. Never this checkout: session state is keyed by project
 *    directory, and a bench run here would collide with the live session.
 *
 * Usage:
 *   bun scripts/profile/git-tool-ab.ts [--only=before|after] [--timeout=ms]
 *                                      [--keep] [--json]
 */
import { spawnSync } from 'child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SENTINEL = 'BENCH_DONE'
const MODEL = 'claude-sonnet-5'
const STEPS = 15

/**
 * Both arms get exactly this list. `Bash(git:*)` and `Git` are both present so
 * the model's choice is free; removing either would answer the question by
 * fiat. Edit/Write are needed for the two steps that change a file.
 */
const ALLOWED_TOOLS = 'Bash(git:*),Git,Read,Edit,Write,Grep,Glob'

/**
 * Source files copied into the bench repository. Real code, because a diff over
 * generated lorem does not exercise the summarizer's language handling, and
 * deliberately NOT the Git tool's own sources — a model reading them would
 * learn which tool the bench is measuring.
 */
const FIXTURE_FILES = [
  'src/shared/errors.ts',
  'src/shared/log.ts',
  'src/shared/fs/cwd.ts',
  'src/shared/fs/path.ts',
  'src/shared/envUtils.ts',
] as const

/** Fixed so both arms get identical commit hashes. */
const FIXED_DATE = '2026-01-15T12:00:00+00:00'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Bench',
  GIT_AUTHOR_EMAIL: 'bench@example.invalid',
  GIT_COMMITTER_NAME: 'Bench',
  GIT_COMMITTER_EMAIL: 'bench@example.invalid',
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

type Args = {
  only: 'before' | 'after' | null
  timeoutMs: number
  keep: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { only: null, timeoutMs: 1_800_000, keep: false, json: false }
  for (const x of argv) {
    if (x === '--keep') a.keep = true
    else if (x === '--json') a.json = true
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
  }
  return a
}

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  })
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd} (${res.status}):\n${res.stderr ?? ''}`,
    )
  }
}

/**
 * Build the bench repository from scratch, deterministically.
 *
 * Rebuilt per arm rather than snapshot-and-restored: a fresh tree cannot carry
 * over an index, a reflog or a stray object from the previous arm, and the
 * construction is cheap.
 */
function buildBenchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-tool-ab-'))
  mkdirSync(join(dir, 'src'), { recursive: true })

  for (const rel of FIXTURE_FILES) {
    const src = join(REPO_ROOT, rel)
    if (!existsSync(src)) throw new Error(`fixture source missing: ${rel}`)
    cpSync(src, join(dir, 'src', rel.split('/').pop() as string))
  }
  writeFileSync(
    join(dir, 'README.md'),
    '# bench\n\nA small utility library.\n',
    'utf8',
  )

  git(dir, ['init', '-q', '-b', 'main'])
  // Three commits, so `git log` and `git show` have something to say.
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'chore: add readme'])
  git(dir, ['add', 'src/errors.ts', 'src/log.ts'])
  git(dir, ['commit', '-q', '-m', 'feat: add error and logging helpers'])
  git(dir, ['add', 'src/cwd.ts', 'src/path.ts', 'src/envUtils.ts'])
  git(dir, ['commit', '-q', '-m', 'feat: add path, cwd and env helpers'])

  // Uncommitted work across three files plus one untracked file, so the very
  // first step has a real diff to summarize.
  appendLines(dir, 'src/path.ts', [
    '',
    'export function isSubPath(parent: string, child: string): boolean {',
    '  return child.startsWith(parent.endsWith("/") ? parent : parent + "/")',
    '}',
  ])
  appendLines(dir, 'src/envUtils.ts', [
    '',
    'export function envFlagNames(env: NodeJS.ProcessEnv): string[] {',
    '  return Object.keys(env).filter(k => k.startsWith("CLAUDIN_"))',
    '}',
  ])
  patchFirst(dir, 'src/cwd.ts', 'export', '// TODO: revisit this export\nexport')
  writeFileSync(join(dir, 'src', 'scratch.ts'), 'export const scratch = 1\n', 'utf8')

  return dir
}

function appendLines(dir: string, rel: string, lines: string[]): void {
  const file = join(dir, rel)
  writeFileSync(file, `${readFileSync(file, 'utf8')}${lines.join('\n')}\n`, 'utf8')
}

function patchFirst(dir: string, rel: string, needle: string, replacement: string): void {
  const file = join(dir, rel)
  const text = readFileSync(file, 'utf8')
  const at = text.indexOf(needle)
  if (at === -1) throw new Error(`patch needle "${needle}" not found in ${rel}`)
  writeFileSync(
    file,
    text.slice(0, at) + replacement + text.slice(at + needle.length),
    'utf8',
  )
}

/**
 * The workload.
 *
 * Every step is phrased as a QUESTION ABOUT THE REPOSITORY, never as a command
 * to run — naming a tool (or even a git invocation) would measure compliance
 * instead of choice, and choice is the thing under test.
 *
 * Steps 9 and 13 re-ask for the whole diff after an edit: that is the delta
 * lane's case. Step 11 asks for a commit message right after one of those
 * re-reads, which is the failure mode the plan flags as the accepted risk — a
 * message written from a partial diff is visible in the transcript dump.
 */
function buildPrompt(): string {
  const steps = [
    'Summarize the uncommitted changes in this repository.',
    'Which changed file has the most modified lines right now?',
    'Show me exactly what changed in src/path.ts.',
    'What is the state of the working tree — is anything untracked?',
    'List the commits on this branch with their subjects.',
    'Which files did the most recent commit touch?',
    'Show me the full contents of the most recent commit.',
    'Append the line `// bench: step 8` to the end of src/log.ts.',
    'Review the complete working-tree diff again and tell me what is in it now.',
    'Which changed files are staged and which are not?',
    'Draft a conventional-commit message covering ALL of the current changes.',
    'Append the line `// bench: step 12` to the end of src/errors.ts.',
    'Review the complete working-tree diff once more and tell me what is in it now.',
    'What branch am I on, and how many commits does it have?',
    'In three bullets, what would a reviewer need to know about the current diff?',
  ]
  if (steps.length !== STEPS) throw new Error(`expected ${STEPS} steps, got ${steps.length}`)
  return [
    `Work through a fixed ${STEPS}-step review of THIS repository, in order.`,
    `STRICT RULES — the benchmark is INVALID if you break any of them:`,
    `- Do the steps strictly in order, one per message turn. Do NOT stop early.`,
    `- Answer each step from the repository's actual state, not from memory.`,
    `- Do NOT print the end token until AFTER step ${STEPS}.`,
    `Steps:`,
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    ``,
    `After step ${STEPS}, end your final message with the exact token ${SENTINEL}.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Stream/transcript parsing.
//
// Copied from `scripts/profile/cache-ab-bench.ts` (:393, :421, :441, :488),
// which self-executes `main()` on import and exports nothing, so it cannot be
// imported. The dedupe-by-message-id, last-wins rule and the
// transcript-fallback are load-bearing and documented there; do not "simplify"
// them here without reading that file's comments first.
// ---------------------------------------------------------------------------

type TimelineRow = { in: number; out: number; cR: number; cW: number }

function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      // A truncated final line is expected while a run is in flight.
    }
  }
  return out
}

function timelineFrom(events: Record<string, unknown>[]): TimelineRow[] {
  const byId = new Map<string, TimelineRow & { order: number }>()
  let order = 0
  for (const v of events) {
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const u = msg.usage as Record<string, unknown> | undefined
    if (!u) continue
    const id = String(msg.id ?? `__anon_${order}`)
    const row = {
      in: Number(u.input_tokens ?? 0),
      out: Number(u.output_tokens ?? 0),
      cR: Number(u.cache_read_input_tokens ?? 0),
      cW: Number(u.cache_creation_input_tokens ?? 0),
      order: byId.get(id)?.order ?? order++,
    }
    const prev = byId.get(id)
    const rowHasData = row.in + row.out + row.cR + row.cW > 0
    const prevHasData = prev ? prev.in + prev.out + prev.cR + prev.cW > 0 : false
    if (!prev || rowHasData || !prevHasData) byId.set(id, row)
  }
  return [...byId.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _o, ...r }) => r)
}

function sessionIdFrom(events: Record<string, unknown>[]): string | null {
  for (const v of events) {
    if (v.type === 'system' && v.subtype === 'init' && typeof v.session_id === 'string') {
      return v.session_id
    }
  }
  return null
}

function transcriptPath(sessionId: string): string | null {
  const configDir = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
  const projectsDir = join(configDir, 'projects')
  if (!existsSync(projectsDir)) return null
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function scalarsFrom(events: Record<string, unknown>[]): {
  costUsd: number | null
  numTurns: number | null
  model: string | null
} {
  let costUsd: number | null = null
  let numTurns: number | null = null
  let model: string | null = null
  for (const v of events) {
    if (v.type === 'assistant') {
      const msg = (v.message ?? {}) as Record<string, unknown>
      if (typeof msg.model === 'string' && !model) model = msg.model
    }
    if (v.type !== 'result') continue
    if (typeof v.total_cost_usd === 'number') costUsd = v.total_cost_usd
    if (typeof v.num_turns === 'number') numTurns = v.num_turns
  }
  return { costUsd, numTurns, model }
}

// ---------------------------------------------------------------------------
// Tool-choice accounting — the question the token numbers cannot answer.
// ---------------------------------------------------------------------------

const VCS_HEAD_RE = /^\s*(?:git|gh)\b/
/**
 * Shell operators a compound Bash command is split on before counting.
 *
 * Load-bearing for fairness: the arm WITHOUT the tool batches too, it just does
 * it with `&&` (`git status && echo --- && git diff` is one call carrying two
 * git commands). Counting that as a single command would invent a batching win
 * for the Git tool that the measurement does not support.
 */
const SHELL_SEGMENT_RE = /&&|\|\||;|\|/

type ToolCall = { name: string; vcs: boolean; commands: number }

function toolCallsFrom(events: Record<string, unknown>[]): ToolCall[] {
  const calls: ToolCall[] = []
  const seen = new Set<string>()
  for (const v of events) {
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use') continue
      const id = String(b.id ?? '')
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      const name = String(b.name ?? '')
      const input = (b.input ?? {}) as Record<string, unknown>
      if (name === 'Git') {
        const list = Array.isArray(input.commands) ? input.commands : []
        calls.push({ name, vcs: true, commands: list.length })
        continue
      }
      if (name === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        const segments = command
          .split(SHELL_SEGMENT_RE)
          .filter(s => VCS_HEAD_RE.test(s))
        calls.push({ name, vcs: segments.length > 0, commands: segments.length })
        continue
      }
      calls.push({ name, vcs: false, commands: 0 })
    }
  }
  return calls
}

/**
 * The batching measures.
 *
 * `commandsPerCall` is the one that means something: how many git/gh commands
 * ride on each version-control tool call, whether they got there via a
 * `commands` list or via `&&`. `mean` (calls per consecutive burst) is kept
 * because the plan asks for it, but it moves with how much git work the model
 * chose to do, so it is not on its own evidence of anything.
 */
function callsPerBurst(calls: ToolCall[]): {
  bursts: number
  mean: number
  vcsCalls: number
  vcsCommands: number
  commandsPerCall: number
} {
  let bursts = 0
  let vcsCalls = 0
  let vcsCommands = 0
  let inBurst = false
  for (const c of calls) {
    if (c.vcs) {
      vcsCalls++
      vcsCommands += c.commands
      if (!inBurst) {
        bursts++
        inBurst = true
      }
    } else {
      inBurst = false
    }
  }
  return {
    bursts,
    mean: bursts === 0 ? 0 : vcsCalls / bursts,
    vcsCalls,
    vcsCommands,
    commandsPerCall: vcsCalls === 0 ? 0 : vcsCommands / vcsCalls,
  }
}

type ArmResult = {
  label: string
  exitCode: number
  wallMs: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  endContext: number
  costUsd: number | null
  numTurns: number | null
  model: string | null
  sawSentinel: boolean
  calls: ToolCall[]
  gitToolCalls: number
  gitToolCommands: number
  bashVcsCalls: number
  bursts: number
  callsPerBurst: number
  vcsCalls: number
  vcsCommands: number
  commandsPerCall: number
  transcript: string | null
  stderr: string
}

function runArm(label: string, extraEnv: Record<string, string>, args: Args): ArmResult {
  const cwd = buildBenchRepo()
  const prompt = buildPrompt()
  const t0 = performance.now()
  const res = spawnSync(
    join(REPO_ROOT, 'bin', 'claudin'),
    [
      '-p',
      prompt,
      '--model',
      MODEL,
      '--output-format',
      'stream-json',
      '--verbose',
      // Identical in both arms on purpose. An allowlist that admitted only one
      // of Bash/Git would decide the tool-choice question the bench is asking.
      '--allowedTools',
      ALLOWED_TOOLS,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: args.timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_MODEL: MODEL,
        // Headless `-p` drains auto-backgrounded sub-agents non-deterministically.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        // Otherwise the second arm can replay the first arm's tool results.
        CLAUDIN_DISABLE_TOOL_RESULT_CACHE: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  const events = parseJsonl(stdout)

  let timeline = timelineFrom(events)
  let allEvents = events
  const sid = sessionIdFrom(events)
  const tPath = sid ? transcriptPath(sid) : null
  if (tPath) {
    // The stream emits assistant events before the final usage arrives; the
    // transcript is flushed after that mutation and carries the real numbers.
    const tEvents = parseJsonl(readFileSync(tPath, 'utf8'))
    const tTimeline = timelineFrom(tEvents)
    if (!timeline.some(r => r.in + r.out + r.cR + r.cW > 0) && tTimeline.length > 0) {
      timeline = tTimeline
    }
    if (toolCallsFrom(tEvents).length >= toolCallsFrom(events).length) allEvents = tEvents
  }

  const sums = timeline.reduce(
    (acc, r) => ({
      input: acc.input + r.in,
      output: acc.output + r.out,
      cacheRead: acc.cacheRead + r.cR,
      cacheCreation: acc.cacheCreation + r.cW,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  )
  const last = timeline[timeline.length - 1]
  const scalars = scalarsFrom(events)
  const calls = toolCallsFrom(allEvents)
  const burst = callsPerBurst(calls)

  if (!args.keep) rmSync(cwd, { recursive: true, force: true })

  return {
    label,
    exitCode: res.status ?? -1,
    wallMs,
    ...sums,
    endContext: last ? last.in + last.cR + last.cW : 0,
    ...scalars,
    sawSentinel: stdout.includes(SENTINEL),
    calls,
    gitToolCalls: calls.filter(c => c.name === 'Git').length,
    gitToolCommands: calls
      .filter(c => c.name === 'Git')
      .reduce((a, c) => a + c.commands, 0),
    bashVcsCalls: calls.filter(c => c.name === 'Bash' && c.vcs).length,
    bursts: burst.bursts,
    callsPerBurst: burst.mean,
    vcsCalls: burst.vcsCalls,
    vcsCommands: burst.vcsCommands,
    commandsPerCall: burst.commandsPerCall,
    transcript: tPath,
    stderr: res.stderr ?? '',
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function delta(before: number, after: number): string {
  if (before === 0) return after === 0 ? '0%' : 'n/a'
  const pct = ((after - before) / before) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function row(label: string, b: string, a: string, d: string): string {
  return `  ${label.padEnd(26)} ${b.padStart(12)} ${a.padStart(12)} ${d.padStart(9)}`
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const arms: ArmResult[] = []

  if (args.only !== 'after') {
    console.log('running arm: before (CLAUDIN_DISABLE_GIT_TOOL=1) …')
    arms.push(runArm('before', { CLAUDIN_DISABLE_GIT_TOOL: '1' }, args))
  }
  if (args.only !== 'before') {
    console.log('running arm: after (tool on, delta on) …')
    arms.push(runArm('after', {}, args))
  }

  for (const arm of arms) {
    const bad: string[] = []
    if (arm.exitCode !== 0) bad.push(`exit=${arm.exitCode}`)
    if (!arm.sawSentinel) bad.push('sentinel missing (run did not finish the steps)')
    if (arm.model && !arm.model.includes('sonnet-5')) bad.push(`WRONG MODEL: ${arm.model}`)
    if (bad.length > 0) {
      console.log(`\n!! arm ${arm.label} is NOT clean: ${bad.join(', ')}`)
      if (arm.stderr) console.log(arm.stderr.split('\n').slice(0, 20).map(l => `   | ${l}`).join('\n'))
    }
  }

  const before = arms.find(a => a.label === 'before')
  const after = arms.find(a => a.label === 'after')

  for (const arm of arms) {
    console.log(
      `\n${arm.label}: model=${arm.model ?? '?'} turns=${arm.numTurns ?? '?'} ` +
        `wall=${(arm.wallMs / 1000).toFixed(1)}s sentinel=${arm.sawSentinel ? 'Y' : 'N'} ` +
        `transcript=${arm.transcript ?? '(none)'}`,
    )
    console.log(
      `  tools: ${arm.calls.length} calls — Git ${arm.gitToolCalls} ` +
        `(${arm.gitToolCommands} commands), Bash-vcs ${arm.bashVcsCalls}, ` +
        `vcs calls ${arm.vcsCalls} carrying ${arm.vcsCommands} commands ` +
        `(${arm.commandsPerCall.toFixed(2)}/call), bursts ${arm.bursts}, ` +
        `calls/burst ${arm.callsPerBurst.toFixed(2)}`,
    )
  }

  if (before && after) {
    console.log(`\n${' '.repeat(28)}${'before'.padStart(12)}${'after'.padStart(13)}${'delta'.padStart(10)}`)
    console.log(row('input', fmt(before.input), fmt(after.input), delta(before.input, after.input)))
    console.log(row('output', fmt(before.output), fmt(after.output), delta(before.output, after.output)))
    console.log(row('cache_creation (write)', fmt(before.cacheCreation), fmt(after.cacheCreation), delta(before.cacheCreation, after.cacheCreation)))
    console.log(row('cache_read', fmt(before.cacheRead), fmt(after.cacheRead), delta(before.cacheRead, after.cacheRead)))
    console.log(row('end context', fmt(before.endContext), fmt(after.endContext), delta(before.endContext, after.endContext)))
    console.log(row('cost usd', before.costUsd?.toFixed(4) ?? 'n/a', after.costUsd?.toFixed(4) ?? 'n/a', before.costUsd && after.costUsd ? delta(before.costUsd, after.costUsd) : 'n/a'))
    console.log(row('tool calls', String(before.calls.length), String(after.calls.length), delta(before.calls.length, after.calls.length)))
    console.log(row('vcs tool calls', String(before.vcsCalls), String(after.vcsCalls), delta(before.vcsCalls, after.vcsCalls)))
    console.log(row('git commands', String(before.vcsCommands), String(after.vcsCommands), delta(before.vcsCommands, after.vcsCommands)))
    console.log(row('commands per vcs call', before.commandsPerCall.toFixed(2), after.commandsPerCall.toFixed(2), delta(before.commandsPerCall, after.commandsPerCall)))
    console.log(row('calls per git burst', before.callsPerBurst.toFixed(2), after.callsPerBurst.toFixed(2), delta(before.callsPerBurst, after.callsPerBurst)))

    if (after.gitToolCalls === 0) {
      console.log(
        `\n!! HEADLINE: the "after" arm never called the Git tool. Every token ` +
          `number below is measuring the description's cost with none of its benefit.`,
      )
    }
  }

  if (args.json) {
    const out = join(REPO_ROOT, 'scripts', 'profile', 'git-tool-ab.json')
    writeFileSync(out, JSON.stringify(arms, null, 2))
    console.log(`\njson → ${out}`)
  }
  console.log()
}

main()
