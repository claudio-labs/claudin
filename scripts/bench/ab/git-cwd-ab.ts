#!/usr/bin/env bun
// Git `cwd` A/B: when the question is about ANOTHER checkout, does the
// `cd /other && git show …` refusal move the model to `Git({cwd, commands})`,
// and what does the answer cost either way?
//
// The 2026-09-10 census counted 229 Bash `cd <other-repo> && git …` calls in
// two days (a cross-fork audit; 415k chars of raw `git show`), none of which
// the Git tool could take: it ran in the session cwd only and the redirect
// was anchored at `^git`. Two changes: a `cwd` parameter on the tool, and
// the redirect now recognises `cd /abs && git <read>` and suggests exactly
// that call.
//
// Fixture, rebuilt per rep: `home` (a git repo, the session cwd) and
// `other` (a second repo with three commits over five copied source files,
// the last one adding a marker line to three of them). The prompt names
// `other` and asks which files its last commit touched, with counts, and
// what the change to one file adds — a `git show` in the other checkout is
// the natural move.
//
//   redirect-off  CLAUDIN_DISABLE_GIT_REDIRECT=1   Bash runs the cd+git as typed
//   redirect-on   default                          refused once, cwd suggested
//
// Measured per run: Bash `cd … && git` calls, Git-tool calls carrying `cwd`,
// tool-result chars, cost, and correctness (the three file names and the
// marker). `--tools Bash,Git,Read,Grep,Glob --strict-mcp-config`.
//
// Measured 2026-09-10, Sonnet 5, reps=3, 6/6 correct: the model called
// `Git({cwd, commands:["git show …"]})` first, in BOTH arms, every rep —
// 2 calls, ~800 chars of budgeted result, $0.040 — so the refusal never
// fired (bashCdGit 0/0/0) and the arms are equal (−0.6%, overlap). The
// parameter's description is what moved it; the redirect is the safety net
// for the day the model types the cd anyway. The census's 229 `cd && git`
// calls have no "before" arm here — that binary had no `cwd` to offer.
//
// Usage:
//   bun run scripts/bench/ab/git-cwd-ab.ts --model=claude-sonnet-5 --reps=3

import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.ts'
import { priceFor } from './forkBench.ts'
import { median, parseArgs, runHeadless, transcriptPath } from './headlessProbe.ts'

const MARKER = 'BENCH_MARKER_9c2e'
const FILES = [
  'src/shared/errors.ts',
  'src/shared/log.ts',
  'src/shared/fs/cwd.ts',
  'src/shared/fs/path.ts',
  'src/shared/envUtils.ts',
]
const TOUCHED = FILES.slice(0, 3)

type Arm = { label: string; env: Record<string, string> }
const ARMS: Arm[] = [
  { label: 'redirect-off', env: { CLAUDIN_DISABLE_GIT_REDIRECT: '1' } },
  { label: 'redirect-on', env: {} },
]

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=b@b', '-c', 'user.name=bench', ...args], { cwd, stdio: 'ignore' })
}

function makeRepos(): { home: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-cwd-ab-'))
  const home = join(root, 'home')
  const other = join(root, 'other')
  for (const dir of [home, other]) {
    mkdirSync(join(dir, 'src', 'shared', 'fs'), { recursive: true })
    for (const f of FILES) cpSync(join(REPO_ROOT, f), join(dir, f))
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'import shared modules')
  }
  // Two more commits in `other`, the last one the question is about.
  appendFileSync(join(other, FILES[4]!), '\n// second commit\n')
  git(other, 'commit', '-q', '-am', 'touch envUtils')
  for (const f of TOUCHED) appendFileSync(join(other, f), `\n// ${MARKER}: added by the bench\nexport const benchMarker = '${MARKER}'\n`)
  git(other, 'commit', '-q', '-am', 'add the bench marker')
  return { home, other }
}

type Row = { arm: string; rep: number; bashCdGit: number; gitCwd: number; resultChars: number; cost: number; correct: boolean; calls: number }

async function main() {
  const args = parseArgs(process.argv.slice(2), { model: 'claude-sonnet-5', timeoutMs: 600_000 })
  const { price, label } = priceFor(args.model)
  const rows: Row[] = []
  let failures = 0
  for (let rep = 1; rep <= args.reps; rep++) {
    const order = rep % 2 === 1 ? ARMS : [...ARMS].reverse()
    for (const arm of order) {
      const { home, other } = makeRepos()
      const prompt =
        `Another checkout of this project lives at ${other}. Using git, answer: ` +
        `1. Which files did its most recent commit touch, with added/removed line counts? ` +
        `2. What does that commit add to ${FILES[0]}? One sentence. ` +
        `Reply with the list and the sentence, nothing else.`
      const run = await runHeadless({
        bin: args.bin,
        model: args.model,
        cwd: home,
        prompt,
        env: arm.env,
        timeoutMs: args.timeoutMs,
        extraArgs: ['--tools', 'Bash,Git,Read,Grep,Glob', '--strict-mcp-config', '--max-turns', '30'],
      })
      if (run.calls.length === 0) {
        console.log(`  rep ${rep} ${arm.label.padEnd(12)} no calls (stderr: ${run.stderr.slice(0, 160)})`)
        failures++
        continue
      }
      // Tool inputs are not in the stream's tool_results; read them off the transcript.
      const transcript = readTranscript(home, run.sessionId)
      const bashCdGit = transcript.filter(u => u.name === 'Bash' && /^cd\s+\S+\s*&&\s*git\b/.test(String(u.input.command ?? ''))).length
      const gitCwd = transcript.filter(u => u.name === 'Git' && typeof u.input.cwd === 'string').length
      const resultChars = run.toolResults.reduce((s, r) => s + r.text.length, 0)
      let cost = 0
      for (const c of run.calls) {
        const w5 = c.usage.cache_creation?.ephemeral_5m_input_tokens ?? c.cc
        const w1h = c.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
        cost += (c.in * price.input + w5 * price.write5m + w1h * price.write1h + c.cr * price.read + c.out * price.output) / 1e6
      }
      const correct = TOUCHED.every(f => run.finalText.includes(basename(f))) && run.finalText.includes(MARKER)
      if (!correct) failures++
      rows.push({ arm: arm.label, rep, bashCdGit, gitCwd, resultChars, cost, correct, calls: run.calls.length })
      console.log(
        `  rep ${rep} ${arm.label.padEnd(12)} ${correct ? 'PASS' : 'FAIL'} calls=${String(run.calls.length).padStart(2)} bashCdGit=${bashCdGit} gitCwd=${gitCwd} resultChars=${String(resultChars).padStart(6)} cost=$${cost.toFixed(4)}`,
      )
    }
  }
  console.log(`\n=== GIT CWD A/B model=${args.model} (${label}) reps=${args.reps} ===`)
  for (const arm of ARMS) {
    const r = rows.filter(x => x.arm === arm.label)
    if (!r.length) continue
    console.log(
      `${arm.label.padEnd(12)} n=${r.length} cost median=$${median(r.map(x => x.cost)).toFixed(4)} [${Math.min(...r.map(x => x.cost)).toFixed(4)}–${Math.max(...r.map(x => x.cost)).toFixed(4)}] resultChars median=${Math.round(median(r.map(x => x.resultChars)))} bashCdGit=${r.map(x => x.bashCdGit).join('/')} gitCwd=${r.map(x => x.gitCwd).join('/')} correct=${r.filter(x => x.correct).length}/${r.length}`,
    )
  }
  const off = rows.filter(x => x.arm === 'redirect-off').map(x => x.cost)
  const on = rows.filter(x => x.arm === 'redirect-on').map(x => x.cost)
  if (off.length && on.length) {
    const disjoint = Math.max(...on) < Math.min(...off) || Math.max(...off) < Math.min(...on)
    console.log(`   on vs off: ${(((median(on) - median(off)) / median(off)) * 100).toFixed(1)}% cost, ranges ${disjoint ? 'disjoint' : 'OVERLAP'}`)
  }
  console.log(`failures: ${failures}`)
  process.exit(failures ? 1 : 0)
}

type ToolUse = { name: string; input: Record<string, unknown> }

function readTranscript(cwd: string, sessionId: string): ToolUse[] {
  const out: ToolUse[] = []
  const seen = new Set<string>()
  let raw = ''
  try { raw = readFileSync(transcriptPath(cwd, sessionId), 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let v: { type?: string; message?: { content?: unknown } }
    try { v = JSON.parse(line) } catch { continue }
    if (v.type !== 'assistant') continue
    for (const b of (v.message?.content ?? []) as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
      if (b.type !== 'tool_use' || !b.id || seen.has(b.id)) continue
      seen.add(b.id)
      out.push({ name: String(b.name), input: b.input ?? {} })
    }
  }
  return out
}

main()
