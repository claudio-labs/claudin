#!/usr/bin/env bun
/**
 * Build tool A/B — what the tool costs and saves in a real conversation.
 *
 * `liveCoverage.test.ts` measures one build's payload against its own raw log.
 * It cannot answer the question that decides whether this tool should ship: in
 * a live session, does the model reach for it instead of Bash, and does the
 * always-present description cost more than the trimmed reports save.
 *
 * Protocol (mirrors `git-tool-ab.ts` — do not "improve" it):
 *
 *  - ONE run per arm, 15 steps. A single run is noisy; the reporting leans on
 *    the large deltas and prints the raw numbers rather than hiding the noise
 *    behind a median of runs that were never made. Use --reps for more.
 *  - TWO arms on ONE build, flipping a killswitch. `before` sets
 *    CLAUDIN_DISABLE_BUILD_TOOL=1, which drops the tool from the toolset — so
 *    the comparison also prices its description, paid on every request, and
 *    (because the Bash redirect is gated on the tool being present) turns the
 *    redirect off with it. Comparing two binaries instead is what made the
 *    clip-pin A/B uncitable.
 *  - Sonnet 5, pinned explicitly. A run that reports another model is thrown
 *    away, not reported.
 *  - A throwaway polyglot workspace under the OS temp dir, rebuilt
 *    byte-identically before each arm. Never this checkout: session state is
 *    keyed by project directory, and a bench run here would collide with the
 *    live session.
 *
 * Caveat the numbers cannot show: `go`, `cargo` and `bun` keep caches OUTSIDE
 * the workspace, so the second arm runs warmer. That moves wall time, not
 * tokens — do not read the wall column as a result.
 *
 * Usage:
 *   bun scripts/profile/build-tool-ab.ts [--only=before|after] [--reps=N]
 *                                        [--timeout=ms] [--keep] [--json]
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { detectBuild, detectBuildSystemFromCommand } from '../../src/tools/BuildTool/detect.js'
import { BUILD_TOOL_NAME } from '../../src/tools/BuildTool/prompt.js'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SENTINEL = 'BENCH_DONE'
const MODEL = 'claude-sonnet-5'
const STEPS = 15

/**
 * Both arms get exactly this list. Bash is unrestricted so the model's choice
 * between it and the tool is free; restricting it would answer the question by
 * fiat. Edit is needed for the steps that fix a compile error.
 */
const ALLOWED_TOOLS = `Bash,${BUILD_TOOL_NAME},Read,Edit,Write,Grep,Glob`

// ---------------------------------------------------------------------------
// The workspace. Five projects, five build systems, each with ONE deliberate
// compile error the model has to read out of the build output and fix.
//
// Real toolchains only — a fake runner would measure the harness. Every project
// is deliberately tiny, which is the WORST case for this tool (the source
// excerpt can cost more than a short raw log), so the bench cannot flatter it.
// ---------------------------------------------------------------------------

type Fixture = { files: Record<string, string>; toolchain: string }

const WORKSPACE: Record<string, Fixture> = {
  // `bun build` does not type-check, so the planted error must be syntactic.
  web: {
    toolchain: 'bun',
    files: {
      'package.json': JSON.stringify(
        { name: 'web', private: true, scripts: { build: 'bun build ./src/index.ts --outdir=dist' } },
        null,
        2,
      ),
      'bun.lock': '',
      'src/index.ts': 'export const greeting = = "hello"\n\nexport function greet(): string {\n  return greeting\n}\n',
    },
  },
  api: {
    toolchain: 'go',
    files: {
      'go.mod': 'module api\n\ngo 1.21\n',
      'main.go': 'package main\n\nfunc main() {\n\tvar port int = "8080"\n\tprintln(port)\n}\n',
    },
  },
  core: {
    toolchain: 'cargo',
    files: {
      'Cargo.toml': '[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/platform/main.rs': 'fn main() {\n    let retries: u32 = "three";\n    println!("{retries}");\n}\n',
    },
  },
  native: {
    toolchain: 'cc',
    files: {
      Makefile: 'all: app\n\napp: main.c\n\tcc -o app main.c\n',
      'main.c': '#include <stdio.h>\n\nint main(void) {\n  printf("%d\\n", compute_total());\n  return 0;\n}\n',
    },
  },
  jvm: {
    toolchain: 'javac',
    files: {
      Makefile: 'all:\n\tjavac -d classes Main.java\n',
      'Main.java':
        'public class Main {\n  public static void main(String[] args) {\n    int timeout = "30";\n    System.out.println(timeout);\n  }\n}\n',
    },
  },
}

function buildWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-build-ab-'))
  for (const [project, fixture] of Object.entries(WORKSPACE)) {
    for (const [rel, body] of Object.entries(fixture.files)) {
      const file = join(root, project, rel)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, body)
    }
  }
  return root
}

/** Skip a project whose toolchain this machine does not have, loudly. */
function missingToolchains(): string[] {
  return Object.entries(WORKSPACE)
    .filter(([, f]) => !Bun.which(f.toolchain))
    .map(([name, f]) => `${name} (${f.toolchain})`)
}

/**
 * The workload.
 *
 * Every step is phrased as a QUESTION ABOUT THE CODE, never as a command to run
 * — naming a tool, or even a build command, would measure compliance instead of
 * choice, and choice is the thing under test.
 *
 * The shape is deliberate: each project is asked about while broken, fixed, and
 * in two cases asked about again once clean. That last one is the up-to-date
 * lane, which only the tool can report and Bash cannot.
 */
function buildPrompt(): string {
  const steps = [
    'Does the `web` project compile? If not, what exactly is wrong?',
    'Fix that error in `web` and confirm the project compiles.',
    'Does `web` need rebuilding right now, or is its output current?',
    'Does the `api` project compile? If not, what exactly is wrong?',
    'Fix that error in `api` and confirm the project compiles.',
    'Does the `core` project compile? If not, what exactly is wrong?',
    'Fix that error in `core` and confirm the project compiles.',
    'Does `core` need rebuilding right now, or is its output current?',
    'Does the `native` project compile? If not, what exactly is wrong?',
    'Fix that error in `native` and confirm the project compiles.',
    'Does the `jvm` project compile? If not, what exactly is wrong?',
    'Fix that error in `jvm` and confirm the project compiles.',
    'Which of the five projects compile cleanly right now?',
    'Change the port value in `api` to a string again and report what the compiler says.',
    'Undo that last change and confirm every project compiles.',
  ]
  if (steps.length !== STEPS) throw new Error(`expected ${STEPS} steps, got ${steps.length}`)
  return [
    `This workspace holds five small projects in different languages, one per directory.`,
    `Work through a fixed ${STEPS}-step review of it, in order.`,
    `STRICT RULES — the benchmark is INVALID if you break any of them:`,
    `- Do the steps strictly in order, one per message turn. Do NOT stop early.`,
    `- Answer each step from what the toolchain actually reports, not from reading the source.`,
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
// Copied from `scripts/profile/git-tool-ab.ts` (:242, :256, :282, :291, :302),
// which copied it from `cache-ab-bench.ts` — that file self-executes `main()`
// on import and exports nothing, so it cannot be imported. The
// dedupe-by-message-id, last-wins rule and the transcript fallback are
// load-bearing and documented there; do not "simplify" them here.
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
// Tool-choice and payload accounting — what the token totals cannot separate.
// ---------------------------------------------------------------------------

/**
 * Shell operators a compound Bash command is split on before classification.
 * The arm without the tool chains builds with `&&`; counting that as one
 * command would invent a batching win the measurement does not support.
 */
const SHELL_SEGMENT_RE = /&&|\|\||;|\|/

/** A Bash segment that is a build, judged by the shipped matcher, not by eye. */
function isBuildCommand(segment: string): boolean {
  return detectBuildSystemFromCommand(segment.trim()) !== 'unknown'
}

type ToolCall = { name: string; id: string; build: boolean; resultChars: number }

function toolCallsFrom(events: Record<string, unknown>[]): ToolCall[] {
  const calls: ToolCall[] = []
  const resultChars = new Map<string, number>()

  // Pass 1: every tool_result, by the id of the call it answers.
  for (const v of events) {
    if (v.type !== 'user') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const body = block.content
      const chars =
        typeof body === 'string'
          ? body.length
          : Array.isArray(body)
            ? (body as Record<string, unknown>[]).reduce(
                (a, b) => a + (typeof b.text === 'string' ? b.text.length : 0),
                0,
              )
            : 0
      resultChars.set(block.tool_use_id, (resultChars.get(block.tool_use_id) ?? 0) + chars)
    }
  }

  // Pass 2: every tool_use, classified.
  for (const v of events) {
    if (v.type !== 'assistant') continue
    const msg = (v.message ?? {}) as Record<string, unknown>
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue
      const id = typeof block.id === 'string' ? block.id : ''
      const input = (block.input ?? {}) as Record<string, unknown>
      const command = typeof input.command === 'string' ? input.command : ''
      const build =
        block.name === BUILD_TOOL_NAME ||
        (block.name === 'Bash' && command.split(SHELL_SEGMENT_RE).some(isBuildCommand))
      if (calls.some(c => c.id === id && id !== '')) continue
      calls.push({ name: block.name, id, build, resultChars: resultChars.get(id) ?? 0 })
    }
  }
  return calls
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
  toolCalls: number
  buildToolCalls: number
  bashBuildCalls: number
  buildResultChars: number
  allResultChars: number
  transcript: string | null
  stderr: string
}

function runArm(label: string, extraEnv: Record<string, string>, args: Args): ArmResult {
  const cwd = buildWorkspace()
  const prompt = buildPrompt()
  const t0 = performance.now()
  const res = spawnSync(
    join(REPO_ROOT, 'bin', 'claudin'),
    ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--allowedTools', ALLOWED_TOOLS],
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
    if (!timeline.some(r => r.in + r.out + r.cR + r.cW > 0) && tTimeline.length > 0) timeline = tTimeline
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
  const calls = toolCallsFrom(allEvents)

  if (!args.keep) rmSync(cwd, { recursive: true, force: true })

  return {
    label,
    exitCode: res.status ?? -1,
    wallMs,
    ...sums,
    endContext: last ? last.in + last.cR + last.cW : 0,
    ...scalarsFrom(events),
    sawSentinel: stdout.includes(SENTINEL),
    toolCalls: calls.length,
    buildToolCalls: calls.filter(c => c.name === BUILD_TOOL_NAME).length,
    bashBuildCalls: calls.filter(c => c.name === 'Bash' && c.build).length,
    buildResultChars: calls.filter(c => c.build).reduce((a, c) => a + c.resultChars, 0),
    allResultChars: calls.reduce((a, c) => a + c.resultChars, 0),
    transcript: tPath,
    stderr: res.stderr ?? '',
  }
}

type Args = {
  only: 'before' | 'after' | null
  timeoutMs: number
  keep: boolean
  json: boolean
  reps: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { only: null, timeoutMs: 2_400_000, keep: false, json: false, reps: 1, dryRun: false }
  for (const x of argv) {
    if (x === '--keep') a.keep = true
    else if (x === '--dry-run') a.dryRun = true
    else if (x === '--json') a.json = true
    else if (x.startsWith('--timeout=')) a.timeoutMs = Number(x.slice('--timeout='.length))
    else if (x.startsWith('--reps=')) a.reps = Number(x.slice('--reps='.length))
    else if (x.startsWith('--only=')) a.only = x.slice('--only='.length) as Args['only']
  }
  return a
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

/** Median, so an outlier rep cannot carry the result. */
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function pick(arms: ArmResult[], key: keyof ArmResult): number {
  return median(arms.map(a => Number(a[key] ?? 0)))
}

/**
 * Prove the fixture before spending model tokens on it: every project must FAIL
 * to build, and fail with the error we planted. A project that happens to
 * compile turns its three steps into a no-op the arms answer identically.
 */
function dryRun(args: Args): void {
  const root = buildWorkspace()
  console.log(`workspace → ${root}\n`)
  let bad = 0
  for (const [project, fixture] of Object.entries(WORKSPACE)) {
    const cwd = join(root, project)
    const detected = detectBuild(cwd)
    if (!detected) {
      console.log(`✗ ${project.padEnd(7)} NOT DETECTED`)
      bad++
      continue
    }
    if (!Bun.which(fixture.toolchain)) {
      console.log(`- ${project.padEnd(7)} ${detected.system.padEnd(7)} skipped, no ${fixture.toolchain}`)
      continue
    }
    const res = spawnSync('sh', ['-c', detected.command], { cwd, encoding: 'utf8' })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    const first = out.split('\n').find(l => /error|Error/.test(l))?.trim() ?? '(no error line)'
    const ok = res.status !== 0
    if (!ok) bad++
    console.log(
      `${ok ? '✓' : '✗'} ${project.padEnd(7)} ${detected.system.padEnd(7)} ` +
        `exit ${String(res.status).padEnd(3)} ${String(out.length).padStart(6)} raw chars — ${first.slice(0, 84)}`,
    )
  }
  if (!args.keep) rmSync(root, { recursive: true, force: true })
  console.log(bad === 0 ? '\nfixture is sound: every project fails as planted' : `\n!! ${bad} project(s) did not fail as planted`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  if (args.dryRun) {
    dryRun(args)
    return
  }

  const missing = missingToolchains()
  if (missing.length > 0) {
    console.log(`!! missing toolchains, those projects will fail to build in BOTH arms: ${missing.join(', ')}`)
  }

  const before: ArmResult[] = []
  const after: ArmResult[] = []
  for (let rep = 0; rep < args.reps; rep++) {
    if (args.only !== 'after') {
      console.log(`running arm: before (CLAUDIN_DISABLE_BUILD_TOOL=1) rep ${rep + 1}/${args.reps} …`)
      before.push(runArm('before', { CLAUDIN_DISABLE_BUILD_TOOL: '1' }, args))
    }
    if (args.only !== 'before') {
      console.log(`running arm: after (tool on) rep ${rep + 1}/${args.reps} …`)
      after.push(runArm('after', {}, args))
    }
  }

  for (const arm of [...before, ...after]) {
    const bad: string[] = []
    if (arm.exitCode !== 0) bad.push(`exit=${arm.exitCode}`)
    if (!arm.sawSentinel) bad.push('sentinel missing (run did not finish the steps)')
    if (arm.model && !arm.model.includes('sonnet-5')) bad.push(`WRONG MODEL: ${arm.model}`)
    if (bad.length > 0) {
      console.log(`\n!! arm ${arm.label} is NOT clean: ${bad.join(', ')}`)
      if (arm.stderr) console.log(arm.stderr.split('\n').slice(0, 20).map(l => `   | ${l}`).join('\n'))
    }
    console.log(
      `\n${arm.label}: model=${arm.model ?? '?'} turns=${arm.numTurns ?? '?'} ` +
        `wall=${(arm.wallMs / 1000).toFixed(1)}s sentinel=${arm.sawSentinel ? 'Y' : 'N'}`,
    )
    console.log(
      `  tools: ${arm.toolCalls} calls — ${BUILD_TOOL_NAME} ${arm.buildToolCalls}, ` +
        `Bash-build ${arm.bashBuildCalls}, build payload ${fmt(arm.buildResultChars)} chars ` +
        `of ${fmt(arm.allResultChars)} total`,
    )
  }

  if (before.length > 0 && after.length > 0) {
    console.log(`\n${' '.repeat(28)}${'before'.padStart(12)}${'after'.padStart(13)}${'delta'.padStart(10)}`)
    const cmp = (label: string, key: keyof ArmResult, f: (n: number) => string = fmt) => {
      const b = pick(before, key)
      const a = pick(after, key)
      console.log(row(label, f(b), f(a), delta(b, a)))
    }
    cmp('input', 'input')
    cmp('output (write)', 'output')
    cmp('cache_creation (write)', 'cacheCreation')
    cmp('cache_read (read)', 'cacheRead')
    cmp('end context', 'endContext')
    cmp('cost usd', 'costUsd', n => n.toFixed(4))
    cmp('tool calls', 'toolCalls', String)
    cmp('build calls', 'buildToolCalls', String)
    cmp('bash build calls', 'bashBuildCalls', String)
    cmp('build payload chars', 'buildResultChars')
    cmp('all payload chars', 'allResultChars')

    if (pick(after, 'buildToolCalls') === 0) {
      console.log(
        `\n!! HEADLINE: the "after" arm never called ${BUILD_TOOL_NAME}. Every token ` +
          `number above prices the description with none of its benefit.`,
      )
    }
  }

  if (args.json) {
    const out = join(REPO_ROOT, 'scripts', 'profile', 'build-tool-ab.json')
    writeFileSync(out, JSON.stringify({ before, after }, null, 2))
    console.log(`\njson → ${out}`)
  }
  console.log()
}

main()
