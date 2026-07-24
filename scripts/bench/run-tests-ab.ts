#!/usr/bin/env bun
// RunTests tool A/B validation: green suite (A) vs failing suite (B), same model.
//
// Goal: prove the RunTests tool end-to-end against a live model — detection →
// `bun test` → reporter/parse → the failures-first summary the model sees. Two
// throwaway bun-test fixtures are generated: one whose tests all PASS (variant A)
// and one with a deliberately failing assertion (variant B). For each variant we
// drive `node dist/cli.mjs -p` with ONLY the RunTests tool allowed (so the model
// cannot fall back to Bash), then read the session transcript to confirm:
//   * A → RunTests was called and its tool_result is a green `✓ … N passed` line
//         with no failing tests.
//   * B → RunTests was called and its tool_result is a red `✗ … Y failed` block
//         that carries a real `file:line` for the broken test.
// A run is trusted only if that structured verdict matches the fixture; a run
// where the model narrated a guess without calling RunTests is marked UNVERIFIED.
//
// Why isolated tmp sandboxes: detection is cwd-scoped and `bun test` executes the
// suite, so each run starts from a fresh, byte-identical fixture outside the repo.
//
// Usage:
//   bun run scripts/bench/run-tests-ab.ts                 # 3 pass + 3 fail, sonnet 5
//   bun run scripts/bench/run-tests-ab.ts --runs=3        # N per variant
//   bun run scripts/bench/run-tests-ab.ts --model=claude-sonnet-5
//   bun run scripts/bench/run-tests-ab.ts --probe         # 1 + 1 quick smoke
//   bun run scripts/bench/run-tests-ab.ts --keep          # keep sandboxes + print paths
//   bun run scripts/bench/run-tests-ab.ts --json          # machine-readable dump

import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = process.env.CLAUDIN_BENCH_ENTRY ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
const FILE_LINE_RE = /\.test\.ts:\d+/

type Variant = 'A' | 'B'
type Kind = 'pass' | 'fail'
const KIND_OF: Record<Variant, Kind> = { A: 'pass', B: 'fail' }

interface Args {
  runs: number
  model: string
  timeoutMs: number
  keep: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runs: 3,
    model: 'claude-sonnet-5',
    timeoutMs: 180_000,
    keep: false,
    json: false,
  }
  for (const a of argv) {
    if (a === '--probe') args.runs = 1
    else if (a === '--keep') args.keep = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--runs=')) args.runs = Math.max(1, Number(a.slice(7)))
    else if (a.startsWith('--model=')) args.model = a.slice(8)
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.slice(10))
  }
  return args
}

// A bun-test fixture: package.json (no test script) + bun.lock so detection
// resolves to `bun test`, plus one deterministic test file. The 'fail' variant
// flips a single assertion so exactly one test fails at a known line.
function makeFixture(kind: Kind): string {
  const dir = mkdtempSync(join(tmpdir(), `rtab-${kind}-`))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `rtab-${kind}`, version: '0.0.0', private: true }, null, 2),
  )
  writeFileSync(join(dir, 'bun.lock'), '') // marks pm=bun → `bun test`
  const broken = kind === 'fail'
  const suite = [
    `import { test, expect } from 'bun:test'`,
    ``,
    `test('addition works', () => {`,
    `  expect(1 + 1).toBe(2)`,
    `})`,
    ``,
    `test('string concat works', () => {`,
    `  expect('a' + 'b').toBe('ab')`,
    `})`,
    ``,
    `test('multiplication works', () => {`,
    `  expect(2 * 3).toBe(${broken ? '7' : '6'})`, // line 13: broken in 'fail'
    `})`,
    ``,
  ].join('\n')
  writeFileSync(join(dir, 'math.test.ts'), suite)
  return dir
}

interface FinalResult {
  sessionId: string
  ok: boolean
  exitCode: number
  costUsd: number
  durationMs: number
  numTurns: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

function parseFinal(stdout: string, exitCode: number): FinalResult {
  const base: FinalResult = {
    sessionId: '',
    ok: false,
    exitCode,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  }
  const last = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(last) as Record<string, unknown>
  } catch {
    return base
  }
  base.sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : ''
  base.ok = parsed.type === 'result' && parsed.subtype === 'success' && exitCode === 0
  base.costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0
  base.durationMs = typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0
  base.numTurns = typeof parsed.num_turns === 'number' ? parsed.num_turns : 0
  const usageRec = (parsed.modelUsage ?? {}) as Record<string, Record<string, number>>
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
  // Fallback: scan every project dir for the session file (path-sanitizing
  // rules can differ from a naive slash→dash replace).
  try {
    for (const proj of readdirSync(projectsDir)) {
      const p = join(projectsDir, proj, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* projects dir missing → no transcript */
  }
  return null
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('\n')
  }
  return ''
}

interface Analysis {
  runTestsCalls: number
  toolCounts: Record<string, number>
  runTestsResults: string[]
}

// Walk the session transcript: count tool_use by name and collect every
// RunTests tool_result string (matched to its tool_use_id).
function analyzeSession(path: string): Analysis {
  const toolCounts: Record<string, number> = {}
  const runTestsIds = new Set<string>()
  const runTestsResults: string[] = []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    let obj: { message?: { role?: string; content?: unknown }; type?: string }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block?.name === 'string') {
        toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1
        if (block.name === 'RunTests' && typeof block.id === 'string') runTestsIds.add(block.id)
      } else if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string') {
        if (runTestsIds.has(block.tool_use_id)) runTestsResults.push(blockText(block.content))
      }
    }
  }
  return { runTestsCalls: toolCounts.RunTests ?? 0, toolCounts, runTestsResults }
}

type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED'

interface RunRow {
  variant: Variant
  kind: Kind
  idx: number
  final: FinalResult
  analysis: Analysis
  verdict: Verdict
  note: string
  wallMs: number
}

// Does the RunTests output the model saw match what the fixture guarantees?
function verify(kind: Kind, a: Analysis): { verdict: Verdict; note: string } {
  if (a.runTestsCalls === 0) return { verdict: 'UNVERIFIED', note: 'RunTests never called' }
  const joined = a.runTestsResults.join('\n')
  if (kind === 'pass') {
    const green = a.runTestsResults.some(r => r.trimStart().startsWith('✓') && /passed/.test(r) && !/failed/.test(r))
    return green
      ? { verdict: 'PASS', note: 'green ✓ summary, no failures' }
      : { verdict: 'FAIL', note: `expected green ✓ summary, got: ${joined.slice(0, 120)}` }
  }
  const red = a.runTestsResults.some(r => r.trimStart().startsWith('✗') && /failed/.test(r))
  const hasLoc = FILE_LINE_RE.test(joined)
  if (red && hasLoc) return { verdict: 'PASS', note: 'red ✗ block with file:line' }
  if (red) return { verdict: 'FAIL', note: 'red ✗ block but no file:line for the failure' }
  return { verdict: 'FAIL', note: `expected red ✗ block, got: ${joined.slice(0, 120)}` }
}

function runOnce(variant: Variant, model: string, idx: number, timeoutMs: number, keep: boolean): RunRow {
  const kind = KIND_OF[variant]
  const sandbox = makeFixture(kind)
  const prompt =
    'Run this project\'s test suite and tell me whether it passed or failed. ' +
    'If anything failed, name the failing test and where it is.'
  const t0 = performance.now()
  const res = spawnSync(
    'node',
    [
      ENTRY,
      '-p',
      prompt,
      '--model',
      model,
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      'RunTests',
    ],
    { cwd: sandbox, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env } },
  )
  const wallMs = performance.now() - t0
  const final = parseFinal(res.stdout ?? '', res.status ?? -1)
  const path = final.sessionId ? sessionPath(final.sessionId, sandbox) : null
  const analysis: Analysis = path
    ? analyzeSession(path)
    : { runTestsCalls: 0, toolCounts: {}, runTestsResults: [] }
  const { verdict, note } = verify(kind, analysis)
  if (!keep) rmSync(sandbox, { recursive: true, force: true })
  else process.stdout.write(`      sandbox: ${sandbox}\n`)
  return { variant, kind, idx, final, analysis, verdict, note, wallMs }
}

const fmt = (n: number) => n.toLocaleString('en-US')
const glyph = (v: Verdict) => (v === 'PASS' ? '✓' : v === 'FAIL' ? '✗' : '?')

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(ENTRY)) {
    console.error(`✗ bundle not found at ${ENTRY} — run \`bun run build\` first.`)
    process.exit(1)
  }
  console.log(`RunTests A/B — model=${args.model}  runs=${args.runs}/variant  (A=passing suite, B=failing suite)\n`)

  const rows: RunRow[] = []
  for (const variant of ['A', 'B'] as Variant[]) {
    const kind = KIND_OF[variant]
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`  [${variant}/${kind}] run#${i + 1} … `)
      const row = runOnce(variant, args.model, i, args.timeoutMs, args.keep)
      rows.push(row)
      const rt = row.analysis.runTestsCalls
      process.stdout.write(
        `${glyph(row.verdict)} ${row.verdict}  (RunTests×${rt}, ${(row.final.durationMs / 1000).toFixed(1)}s, ` +
          `out=${fmt(row.final.output)}tok, $${row.final.costUsd.toFixed(4)}) — ${row.note}\n`,
      )
    }
  }

  console.log('\n── Summary ──')
  for (const variant of ['A', 'B'] as Variant[]) {
    const vr = rows.filter(r => r.variant === variant)
    const pass = vr.filter(r => r.verdict === 'PASS').length
    const kind = KIND_OF[variant]
    const cost = vr.reduce((a, r) => a + r.final.costUsd, 0)
    const calls = vr.reduce((a, r) => a + r.analysis.runTestsCalls, 0)
    console.log(
      `  ${variant} (${kind} suite): ${pass}/${vr.length} verified  ·  ${calls} RunTests calls  ·  $${cost.toFixed(4)} total`,
    )
  }
  const allPass = rows.every(r => r.verdict === 'PASS')
  console.log(`\n${allPass ? '✓ ALL VERIFIED' : '✗ NOT ALL VERIFIED'} — ${rows.filter(r => r.verdict === 'PASS').length}/${rows.length} runs\n`)

  if (args.json) console.log(JSON.stringify(rows, null, 2))
  process.exit(allPass ? 0 : 1)
}

main()
