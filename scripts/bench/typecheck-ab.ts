#!/usr/bin/env bun
// Typecheck tool A/B validation: baseline capture (A) vs one newly introduced
// error against a recorded backlog (B), same model.
//
// Goal: prove end-to-end, against a live model, the one claim that justifies the
// tool — that a project with a large known error backlog reports only what the
// current work broke. Each sandbox is a throwaway git repo carrying N deliberate
// pre-existing type errors:
//
//   * A → one call on a CLEAN tree. Expect a green `✓ … baseline recorded at …`
//         line: every diagnostic present is pre-existing by definition.
//   * B → the same capture, then ONE new error is written and a SECOND CLI run
//         is scored. Expect `⚠ … 1 new`, carrying the new file's position and
//         NOT naming any of the baselined files. That negative is the whole
//         point: a run that lists the backlog has failed even if it is "correct".
//
// A run is trusted only if the structured verdict matches the fixture; a run
// where the model narrated a guess without calling Typecheck is UNVERIFIED.
//
// The token-economy claim is measured WITHOUT a model as well: the bench runs
// the raw compiler in the same sandbox and reports the byte ratio between its
// output and the tool result the model actually received.
//
// Usage:
//   bun run scripts/bench/typecheck-ab.ts                 # 3 per variant, sonnet 5
//   bun run scripts/bench/typecheck-ab.ts --runs=3
//   bun run scripts/bench/typecheck-ab.ts --errors=40     # size of the backlog
//   bun run scripts/bench/typecheck-ab.ts --probe         # 1 + 1 quick smoke
//   bun run scripts/bench/typecheck-ab.ts --keep --json

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = process.env.CLAUDIN_BENCH_ENTRY ?? join(REPO_ROOT, 'dist', 'cli.mjs')
const CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR ?? join(homedir(), '.claudin')
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
const NEW_ERROR_FILE = 'src/introduced.ts'
const FILE_LINE_RE = /introduced\.ts:\d+/

type Variant = 'A' | 'B'
const LABEL: Record<Variant, string> = { A: 'capture', B: 'one new error' }

interface Args {
  runs: number
  model: string
  errors: number
  timeoutMs: number
  keep: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 3, model: 'claude-sonnet-5', errors: 40, timeoutMs: 180_000, keep: false, json: false }
  for (const a of argv) {
    if (a === '--probe') args.runs = 1
    else if (a === '--keep') args.keep = true
    else if (a === '--json') args.json = true
    else if (a.startsWith('--runs=')) args.runs = Math.max(1, Number(a.slice(7)))
    else if (a.startsWith('--errors=')) args.errors = Math.max(1, Number(a.slice(9)))
    else if (a.startsWith('--model=')) args.model = a.slice(8)
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.slice(10))
  }
  return args
}

function git(cwd: string, gitArgs: string[]): void {
  spawnSync('git', gitArgs, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.invalid',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.invalid',
    },
  })
}

/**
 * A committed TypeScript project carrying `errorCount` deliberate type errors —
 * the pre-existing backlog. `.gitignore` covers `.claudin/` so the cache the
 * tool writes does not itself dirty the tree, which is the state that blocks
 * baseline capture.
 */
function makeFixture(errorCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcab-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  try {
    symlinkSync(TSC, join(dir, 'node_modules', '.bin', 'tsc'))
  } catch {
    /* a global tsc on PATH is an acceptable fallback */
  }
  writeFileSync(join(dir, '.gitignore'), '.claudin/\nnode_modules/\n')
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tcab', private: true, scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
  )
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022' }, include: ['src'] }),
  )
  const lines: string[] = []
  for (let i = 0; i < errorCount; i++) {
    lines.push(`export const backlog${i}: number = "not a number ${i}"`)
  }
  writeFileSync(join(dir, 'src', 'backlog.ts'), `${lines.join('\n')}\n`)
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'backlog'])
  return dir
}

function introduceNewError(dir: string): void {
  writeFileSync(join(dir, NEW_ERROR_FILE), 'export const introduced: string = 42\n')
}

/** Bytes the model would have paid for had it run the compiler through Bash. */
function rawCompilerBytes(dir: string): number {
  const res = spawnSync(join(dir, 'node_modules', '.bin', 'tsc'), ['--noEmit', '--pretty', 'false'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return `${res.stdout ?? ''}${res.stderr ?? ''}`.length
}

interface FinalResult {
  sessionId: string
  exitCode: number
  costUsd: number
  durationMs: number
  output: number
}

function parseFinal(stdout: string, exitCode: number): FinalResult {
  const base: FinalResult = { sessionId: '', exitCode, costUsd: 0, durationMs: 0, output: 0 }
  const last = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(last) as Record<string, unknown>
  } catch {
    return base
  }
  base.sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : ''
  base.costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0
  base.durationMs = typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0
  const usage = (parsed.modelUsage ?? {}) as Record<string, Record<string, number>>
  base.output = Number(Object.values(usage)[0]?.outputTokens ?? 0)
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
  calls: number
  results: string[]
}

function analyzeSession(path: string): Analysis {
  const ids = new Set<string>()
  const results: string[] = []
  let calls = 0
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let obj: { message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && block?.name === 'Typecheck') {
        calls++
        if (typeof block.id === 'string') ids.add(block.id)
      } else if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string') {
        if (ids.has(block.tool_use_id)) results.push(blockText(block.content))
      }
    }
  }
  return { calls, results }
}

type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED'

function verify(variant: Variant, a: Analysis): { verdict: Verdict; note: string } {
  if (a.calls === 0) return { verdict: 'UNVERIFIED', note: 'Typecheck never called' }
  const joined = a.results.join('\n')
  if (variant === 'A') {
    return a.results.some(r => r.trimStart().startsWith('✓') && r.includes('baseline recorded at'))
      ? { verdict: 'PASS', note: 'clean tree recorded the backlog' }
      : { verdict: 'FAIL', note: `expected a baseline capture, got: ${joined.slice(0, 140)}` }
  }
  const flagged = a.results.some(r => r.includes('1 new'))
  const located = FILE_LINE_RE.test(joined)
  // The negative half of the claim: the 40 baselined errors must not appear.
  const leaked = /backlog\.ts:\d+/.test(joined)
  if (flagged && located && !leaked) return { verdict: 'PASS', note: 'exactly the new error, backlog hidden' }
  if (leaked) return { verdict: 'FAIL', note: 'the recorded backlog leaked into the result' }
  if (flagged) return { verdict: 'FAIL', note: 'reported 1 new but without a position' }
  return { verdict: 'FAIL', note: `expected "1 new", got: ${joined.slice(0, 140)}` }
}

const PROMPT = 'Type-check this project and tell me whether my changes introduced any new problems. If so, name them and where they are.'

function drive(sandbox: string, model: string, timeoutMs: number): { final: FinalResult; analysis: Analysis } {
  const res = spawnSync(
    'node',
    [ENTRY, '-p', PROMPT, '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Typecheck'],
    { cwd: sandbox, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env } },
  )
  const final = parseFinal(res.stdout ?? '', res.status ?? -1)
  const path = final.sessionId ? sessionPath(final.sessionId, sandbox) : null
  return { final, analysis: path ? analyzeSession(path) : { calls: 0, results: [] } }
}

interface RunRow {
  variant: Variant
  idx: number
  final: FinalResult
  analysis: Analysis
  verdict: Verdict
  note: string
  rawBytes: number
  resultBytes: number
  wallMs: number
}

function runOnce(variant: Variant, args: Args, idx: number): RunRow {
  const sandbox = makeFixture(args.errors)
  const rawBytes = rawCompilerBytes(sandbox)
  const t0 = performance.now()

  // Both variants start by recording the backlog on a clean tree. Variant B
  // then introduces one error and is scored on a SECOND run — the lifecycle a
  // real session goes through, with no internal seeding.
  let { final, analysis } = drive(sandbox, args.model, args.timeoutMs)
  if (variant === 'B') {
    introduceNewError(sandbox)
    ;({ final, analysis } = drive(sandbox, args.model, args.timeoutMs))
  }

  const wallMs = performance.now() - t0
  const { verdict, note } = verify(variant, analysis)
  const resultBytes = analysis.results.join('\n').length
  if (!args.keep) rmSync(sandbox, { recursive: true, force: true })
  else process.stdout.write(`      sandbox: ${sandbox}\n`)
  return { variant, idx, final, analysis, verdict, note, rawBytes, resultBytes, wallMs }
}

const fmt = (n: number) => n.toLocaleString('en-US')
const glyph = (v: Verdict) => (v === 'PASS' ? '✓' : v === 'FAIL' ? '✗' : '?')

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(ENTRY)) {
    console.error(`✗ bundle not found at ${ENTRY} — run \`bun run build\` first.`)
    process.exit(1)
  }
  console.log(
    `Typecheck A/B — model=${args.model}  runs=${args.runs}/variant  backlog=${args.errors} errors  (A=capture, B=one new error)\n`,
  )

  const rows: RunRow[] = []
  for (const variant of ['A', 'B'] as Variant[]) {
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`  [${variant}/${LABEL[variant]}] run#${i + 1} … `)
      const row = runOnce(variant, args, i)
      rows.push(row)
      process.stdout.write(
        `${glyph(row.verdict)} ${row.verdict}  (Typecheck×${row.analysis.calls}, ${(row.wallMs / 1000).toFixed(1)}s, ` +
          `out=${fmt(row.final.output)}tok, $${row.final.costUsd.toFixed(4)}) — ${row.note}\n`,
      )
    }
  }

  console.log('\n── Summary ──')
  for (const variant of ['A', 'B'] as Variant[]) {
    const vr = rows.filter(r => r.variant === variant)
    const pass = vr.filter(r => r.verdict === 'PASS').length
    const cost = vr.reduce((a, r) => a + r.final.costUsd, 0)
    console.log(`  ${variant} (${LABEL[variant]}): ${pass}/${vr.length} verified  ·  $${cost.toFixed(4)} total`)
  }

  // The token-economy claim, measured rather than asserted.
  const scored = rows.filter(r => r.resultBytes > 0)
  if (scored.length > 0) {
    const raw = scored.reduce((a, r) => a + r.rawBytes, 0) / scored.length
    const tool = scored.reduce((a, r) => a + r.resultBytes, 0) / scored.length
    console.log(
      `  payload: raw compiler ${fmt(Math.round(raw))} B → tool result ${fmt(Math.round(tool))} B ` +
        `(${(raw / Math.max(tool, 1)).toFixed(1)}× smaller, mean over ${scored.length} runs)`,
    )
  }

  const allPass = rows.every(r => r.verdict === 'PASS')
  console.log(`\n${allPass ? '✓ ALL VERIFIED' : '✗ NOT ALL VERIFIED'} — ${rows.filter(r => r.verdict === 'PASS').length}/${rows.length} runs\n`)
  if (args.json) console.log(JSON.stringify(rows, null, 2))
  process.exit(allPass ? 0 : 1)
}

main()
