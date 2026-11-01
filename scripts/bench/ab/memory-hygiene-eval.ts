#!/usr/bin/env bun
/**
 * Memory-hygiene eval — does the dream clean, and does it clean only what it
 * should? memory-write-ab.ts gates how a memory is written and
 * memory-recall-eval.ts how it is read; neither ever runs a dream. This one
 * seeds a workspace with the mess the 2026-10 session census found — a
 * private copy of a global memory, two team notes saying one thing, a dated
 * snapshot past its `expires:`, two memories that disagree with nothing to
 * settle it, a memory the code contradicts, a team index over its cap — plus
 * controls that must survive, fires the auto-dream once and grades the
 * directories it leaves. Literal checks on the files, no model judging.
 *
 * Each (arm, rep) is one headless `-p "ok"` session in a fresh git workspace
 * under /tmp/memory-hygiene-eval/<stamp>/, its global memory in a dir of its
 * own handed over as `--settings`. CLAUDIN_AUTO_DREAM_HEADLESS=1 lets the
 * `-p` run dream and waits for it; CLAUDIN_AUTO_DREAM_FORCE=1 opens the time
 * and session gates the fixture cannot meet (autoDream.ts). The dream's
 * cost is its `auto_dream` share of the transcript's last `cost-state`.
 *
 * Gates, written before the hygiene arm ever ran (plan
 * greedy-petting-torvalds.md). Roles: --base (default `base`, the arm with
 * CLAUDIN_MEMORY_HYGIENE=0), --new (default `claudindev`), --placebo
 * (default `placebo`). N is --reps; "≥2/3" scales to ceil(2N/3):
 *   S1 (hard)  every control memory intact — unchanged, or changed only by
 *              additions — in N/N
 *   S2 (hard)  no global memory deleted or shrunk, in N/N
 *   S3         the unresolvable contradiction: both values survive and a
 *              memory carries `contradicts:`, in ≥2/3
 *   E1         the private copy of a global memory is gone and its extra fact
 *              (TypeScript examples) is in the global dir, in ≥2/3
 *   E2         the two team notes are one, with both facts, in ≥2/3
 *   E3         the expired snapshot is folded into its decision and gone, ≥2/3
 *   E4         the team index is under its caps, in ≥2/3
 *   E5         the memory the code contradicts no longer says so, in ≥2/3
 *   M          mechanism: the new arm deletes files; base and placebo cannot
 *   C          median dream cost of new reported against base, flagged > +50%
 *
 * Usage:
 *   bun scripts/bench/ab/memory-hygiene-eval.ts --dry-run    # plan + grader self-test, no tokens
 *   bun scripts/bench/ab/memory-hygiene-eval.ts --reps=3 \
 *     --variant=base:CLAUDIN_MEMORY_HYGIENE=0 \
 *     --variant=placebo:CLAUDIN_MEMORY_HYGIENE=0,CLAUDIN_BENCH_PLACEBO=1 \
 *     --only=base,placebo,claudindev
 *
 * `claudindev` is this checkout's `bin/claudin`; `--variant=<label>:<ENV>=<v>`
 * is the same binary with those set. Run `bun run build` first.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl, transcriptPath } from './cliUsage'
import { fm, frontmatterOf, gitWorkspace, MEMORY_REL } from './memory-write-ab'
import { git, spawnCollect, stamp, table, version } from './session-cache-ab'

const BENCH_ROOT = '/tmp/memory-hygiene-eval'
const INDEX_BYTES = 25_000
const INDEX_LINES = 200

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Files = Record<string, string>

const PROJECT_FILES: Files = {
  'README.md': '# relay-kit\n\nA small HTTP relay.\n',
  'package.json': `${JSON.stringify({ name: 'relay-kit', version: '0.1.0', type: 'module' }, null, 2)}\n`,
  'src/client.ts': '// How many times the upstream client retries before it fails.\nexport const RETRY_LIMIT = 5\n',
}

/** Bodies the grader checks by substring; kept apart so the fixture and the grader agree. */
const BODY = {
  buildFirst: 'Always run `bun run build` before testing a change by hand.',
  runbook: 'The on-call runbook lives at docs/runbook.md: restart the relay with `systemctl restart relay`.',
  testsConvention: 'Every test file sits beside its source as `*.test.ts`.',
  flakyCi: 'The CI job `e2e` flakes on cold caches; re-run it once before investigating.',
  terse: 'The user wants terse answers with no trailing summary.',
  language: 'Answer in Portuguese (PT-BR), in every project.',
  decision: '**Decision:** the main cache TTL is 1h.\n**Why:** sessions resume within the hour.\n**Rejected:** 5m.',
}

const NOTE_COUNT = 50

/** A hook carrying the note's content, as the census found: 50 of them put the team index over 25 KB. */
function noteLine(n: number): string {
  const id = String(n).padStart(2, '0')
  return `- [Component ${id} notes](notes/note-${id}.md) — what component ${id} does, why it was split out of the relay core, who owns it now, which benchmark first measured its latency, what the follow-up is, which flag turns it off, how it fails when the upstream is slow, which dashboard shows its error rate during an incident, which config keys it reads at startup, how its retries interact with the global retry budget, what its log lines look like when the circuit opens, and which teammate reviewed its last change before the release`
}

/** The memories, relative to the project memory root; `@global/` marks the global dir. */
function seedMemories(): Files {
  const notes: Files = {}
  for (let n = 1; n <= NOTE_COUNT; n++) {
    const id = String(n).padStart(2, '0')
    notes[`team/notes/note-${id}.md`] = fm([`name: note-${id}`, `description: notes on component ${id}`, 'type: project'], `Component ${id} forwards requests for its route.`)
  }
  return {
    // E1: a private copy of a global memory, with one fact more.
    'respostas-em-portugues.md': fm(
      ['name: respostas-em-portugues', 'description: o usuário quer as respostas em português', 'type: feedback'],
      'Responder sempre em português. Nos exemplos de código, o usuário prefere TypeScript.',
    ),
    // E5: the code says 5.
    'project-retry-limit.md': fm(['name: project-retry-limit', 'description: how often the upstream client retries', 'type: project'], 'The upstream client retries 3 times before it fails.'),
    'feedback-build-first.md': fm(['name: feedback-build-first', 'description: build before testing by hand', 'type: feedback'], BODY.buildFirst),
    'MEMORY.md': [
      '- [Respostas em português](respostas-em-portugues.md) — PT-BR',
      '- [Retry limit](project-retry-limit.md) — how often the client retries',
      '- [Build first](feedback-build-first.md) — build before a manual test',
      '',
    ].join('\n'),
    // E2: two notes saying one thing.
    'team/deploy-checklist.md': fm(['name: deploy-checklist', 'description: what to do before a deploy', 'type: project'], 'Before a deploy, run the database migrations.'),
    'team/pre-deploy-steps.md': fm(['name: pre-deploy-steps', 'description: the steps before every deploy', 'type: project'], 'Before every deploy, run the database migrations, then tag the release.'),
    // E3: a dated snapshot past its date, supporting a decision.
    'team/bench-cache-2026-08-01.md': fm(
      ['name: bench-cache-2026-08-01', 'description: the 1h cache TTL cut 12% of the session cost (N=3)', 'type: project', 'expires: 2026-09-01'],
      'Measured 2026-08-01: the 1h cache TTL cut 12% of the cost per session (N=3). Supports [[cache-ttl]].',
    ),
    'team/decisions/cache-ttl.md': fm(['name: cache-ttl', 'description: the main cache TTL is 1h', 'type: project', 'scope: cache', 'impact: functional'], BODY.decision),
    // S3: two memories that disagree, nothing in the code to settle it.
    'team/upstream-timeout-a.md': fm(['name: upstream-timeout-a', 'description: the timeout for upstream calls', 'type: project'], 'Upstream calls time out after 15 seconds.'),
    'team/upstream-timeout-b.md': fm(['name: upstream-timeout-b', 'description: the upstream call timeout', 'type: project'], 'Upstream calls time out after 45 seconds.'),
    // Controls.
    'team/docs/runbook.md': fm(['name: runbook', 'description: where the on-call runbook is', 'type: reference'], BODY.runbook),
    'team/conventions-tests.md': fm(['name: conventions-tests', 'description: where test files go', 'type: feedback'], BODY.testsConvention),
    'team/bugs/flaky-ci.md': fm(['name: flaky-ci', 'description: the e2e CI job flakes on cold caches', 'type: project'], BODY.flakyCi),
    ...notes,
    // E4: over the byte cap through its hooks.
    'team/MEMORY.md': [
      '# Team Memory',
      '',
      '## Decisions',
      '- [Cache TTL](decisions/cache-ttl.md) — the main cache TTL is 1h',
      '## Bugs',
      '- [Flaky CI](bugs/flaky-ci.md) — re-run e2e once',
      '## Docs',
      '- [Runbook](docs/runbook.md) — where the on-call runbook is',
      '## Notes',
      '- [Deploy checklist](deploy-checklist.md) — before a deploy',
      '- [Pre-deploy steps](pre-deploy-steps.md) — before every deploy',
      '- [Cache bench 2026-08-01](bench-cache-2026-08-01.md) — 1h TTL −12%',
      '- [Upstream timeout](upstream-timeout-a.md) — the timeout for upstream calls',
      '- [Upstream call timeout](upstream-timeout-b.md) — the timeout for upstream calls',
      '- [Test files](conventions-tests.md) — beside their source',
      ...Array.from({ length: NOTE_COUNT }, (_, i) => noteLine(i + 1)),
      '',
    ].join('\n'),
    '@global/user-language.md': fm(['name: user-language', 'description: the user wants every answer in Portuguese', 'type: user'], BODY.language),
    '@global/feedback-terse.md': fm(['name: feedback-terse', 'description: terse answers, no trailing summary', 'type: feedback'], BODY.terse),
    '@global/MEMORY.md': '- [Language](user-language.md) — PT-BR\n- [Terse](feedback-terse.md) — no trailing summary\n',
  }
}

type Roots = { memory: string; global: string }

function absOf(roots: Roots, rel: string): string {
  return rel.startsWith('@global/') ? join(roots.global, rel.slice('@global/'.length)) : join(roots.memory, rel)
}

function writeMemories(roots: Roots, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = absOf(roots, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** Every `.md` under `dir`, relative to it. */
function listMd(dir: string, sub = ''): string[] {
  const at = join(dir, sub)
  if (!existsSync(at)) return []
  return readdirSync(at, { withFileTypes: true }).flatMap(e => {
    const rel = sub ? `${sub}/${e.name}` : e.name
    return e.isDirectory() ? listMd(dir, rel) : e.name.endsWith('.md') ? [rel] : []
  })
}

/** The memories on disk now, in seedMemories' layout. */
function snapshotOf(roots: Roots): Files {
  const out: Files = {}
  for (const rel of listMd(roots.memory)) out[rel] = readFileSync(join(roots.memory, rel), 'utf8')
  for (const rel of listMd(roots.global)) out[`@global/${rel}`] = readFileSync(join(roots.global, rel), 'utf8')
  return out
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const CONTROLS = ['feedback-build-first.md', 'team/docs/runbook.md', 'team/conventions-tests.md', 'team/bugs/flaky-ci.md', '@global/feedback-terse.md'] as const
const CHECKS = ['S1', 'S2', 'S3', 'E1', 'E2', 'E3', 'E4', 'E5'] as const
type Check = (typeof CHECKS)[number]

export type HygieneGrade = Record<Check, boolean> & { deleted: number; problems: string[] }

const bodyOf = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '').trim()
const isIndex = (rel: string): boolean => rel === 'MEMORY.md' || rel.endsWith('/MEMORY.md')
const isTeam = (rel: string): boolean => rel.startsWith('team/')
const isGlobal = (rel: string): boolean => rel.startsWith('@global/')
const isPrivate = (rel: string): boolean => !isTeam(rel) && !isGlobal(rel)

/** Grades what a dream left (`after`) against what it was handed (`before`). */
export function gradeHygiene(before: Files, after: Files): HygieneGrade {
  const problems: string[] = []
  const memories = (pick: (rel: string) => boolean) => Object.keys(after).filter(rel => pick(rel) && !isIndex(rel))
  const carrying = (pick: (rel: string) => boolean, re: RegExp) => memories(pick).filter(rel => re.test(after[rel]!))

  const brokenControls = CONTROLS.filter(rel => after[rel] === undefined || !after[rel]!.includes(bodyOf(before[rel]!)))
  const S1 = brokenControls.length === 0
  if (!S1) problems.push(`controls changed: ${brokenControls.join(', ')}`)

  const shrunk = Object.keys(before).filter(rel => isGlobal(rel) && (after[rel] === undefined || !after[rel]!.includes(before[rel]!.trim())))
  const S2 = shrunk.length === 0
  if (!S2) problems.push(`global shrunk or deleted: ${shrunk.join(', ')}`)

  const both = carrying(isTeam, /\b15 seconds\b/).length > 0 && carrying(isTeam, /\b45 seconds\b/).length > 0
  const marked = memories(isTeam).some(rel => frontmatterOf(after[rel]!)?.contradicts !== undefined)
  const S3 = both && marked
  if (!S3) problems.push(`contradiction: ${both ? 'both values kept' : 'a value lost'}, ${marked ? 'marked' : 'no contradicts:'}`)

  const privateCopy = carrying(isPrivate, /portugu/i)
  const E1 = privateCopy.length === 0 && carrying(isGlobal, /typescript/i).length > 0
  if (!E1) problems.push(`duplicate: private copies ${privateCopy.length}, TypeScript in global ${carrying(isGlobal, /typescript/i).length > 0}`)

  const deploy = carrying(isTeam, /migrations/i)
  const E2 = deploy.length === 1 && /\btag\b/i.test(after[deploy[0]!]!)
  if (!E2) problems.push(`near-duplicates: ${deploy.length} team files carry the migrations step`)

  const E3 = after['team/bench-cache-2026-08-01.md'] === undefined && /12\s?%/.test(after['team/decisions/cache-ttl.md'] ?? '')
  if (!E3) problems.push(`snapshot: ${after['team/bench-cache-2026-08-01.md'] === undefined ? 'gone' : 'kept'}, decision ${/12\s?%/.test(after['team/decisions/cache-ttl.md'] ?? '') ? 'carries' : 'lacks'} 12%`)

  const index = (after['team/MEMORY.md'] ?? '').trim()
  const E4 = Buffer.byteLength(index) <= INDEX_BYTES && index.split('\n').length <= INDEX_LINES
  if (!E4) problems.push(`team index ${Buffer.byteLength(index)} bytes, ${index.split('\n').length} lines`)

  const E5 = carrying(isPrivate, /retries 3 times/i).length === 0
  if (!E5) problems.push('the retry memory still says 3')

  const deleted = Object.keys(before).filter(rel => after[rel] === undefined).length
  return { S1, S2, S3, E1, E2, E3, E4, E5, deleted, problems }
}

/** The state a dream that did everything right leaves. */
function idealAfter(before: Files): Files {
  const after = { ...before }
  delete after['respostas-em-portugues.md']
  after['@global/user-language.md'] = `${before['@global/user-language.md']!.trimEnd()}\nIn code examples, prefers TypeScript.\n`
  delete after['team/deploy-checklist.md']
  delete after['team/bench-cache-2026-08-01.md']
  after['team/decisions/cache-ttl.md'] = `${before['team/decisions/cache-ttl.md']!.trimEnd()}\n**Evidence:** the 1h TTL cut 12% of the session cost (N=3, 2026-08-01).\n`
  after['team/upstream-timeout-b.md'] = before['team/upstream-timeout-b.md']!.replace('type: project', 'type: project\ncontradicts:\n  - upstream-timeout-a')
  after['project-retry-limit.md'] = before['project-retry-limit.md']!.replace('retries 3 times', 'retries 5 times (src/client.ts RETRY_LIMIT)')
  after['team/MEMORY.md'] = before['team/MEMORY.md']!
    .split('\n')
    .filter(l => !l.includes('deploy-checklist.md') && !l.includes('bench-cache-2026-08-01.md'))
    .map(l => (l.startsWith('- [Component') ? l.slice(0, l.indexOf(' — ') + 3) + 'route notes' : l))
    .join('\n')
  return after
}

// ---------------------------------------------------------------------------
// Running a session
// ---------------------------------------------------------------------------

type Args = {
  reps: number
  only: string[] | null
  model: string
  effort: string
  timeoutMs: number
  dryRun: boolean
  bin: string
  env: Record<string, Record<string, string>>
  variants: string[]
  roles: { base: string; next: string; placebo: string }
}

type Session = { arm: string; rep: number; workspace: string; dreamUsd: number | null; dreamCalls: number | null; exitCode: number; grade: HygieneGrade }

function dreamUsage(sessionId: string | null): { usd: number | null; calls: number | null } {
  const path = sessionId ? transcriptPath(sessionId) : null
  if (!path) return { usd: null, calls: null }
  const state = parseJsonl(readFileSync(path, 'utf8')).findLast(e => e.type === 'cost-state') as
    | { sourceUsage?: Record<string, { costUSD?: number; calls?: number }> }
    | undefined
  const dream = state?.sourceUsage?.auto_dream
  return { usd: dream?.costUSD ?? null, calls: dream?.calls ?? null }
}

async function runSession(args: Args, runDir: string, arm: string, rep: number): Promise<Session> {
  const label = `${arm}-r${rep}`
  const ws = join(runDir, label)
  const roots: Roots = { memory: join(ws, MEMORY_REL), global: join(runDir, `${label}.global`) }
  gitWorkspace(ws, PROJECT_FILES, 'chore: import relay-kit 0.1.0')
  const before = seedMemories()
  writeMemories(roots, before)
  const res = await spawnCollect(
    args.bin,
    [
      '-p',
      'ok',
      '--model',
      args.model,
      '--effort',
      args.effort,
      '--max-turns',
      '3',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--settings',
      JSON.stringify({ autoMemoryGlobalDirectory: roots.global, autoDreamEnabled: true }),
    ],
    ws,
    join(runDir, label),
    args.timeoutMs,
    { ...(args.env[arm] ?? {}), CLAUDIN_AUTO_DREAM_HEADLESS: '1', CLAUDIN_AUTO_DREAM_FORCE: '1' },
  )
  const events = parseJsonl(res.stdout)
  const result = events.findLast(e => e.type === 'result')
  const sessionId = typeof result?.session_id === 'string' ? result.session_id : null
  const usage = dreamUsage(sessionId)
  const grade = gradeHygiene(before, snapshotOf(roots))
  const passed = CHECKS.filter(c => grade[c])
  console.log(
    `[${label}] ${passed.length}/${CHECKS.length} (${passed.join(' ')}) — dream ${usage.usd === null ? '$?' : `$${usage.usd.toFixed(3)}`}, ${usage.calls ?? '?'} calls, ${grade.deleted} deleted` +
      (grade.problems.length ? ` — ${grade.problems.join('; ')}` : ''),
  )
  return { arm, rep, workspace: ws, dreamUsd: usage.usd, dreamCalls: usage.calls, exitCode: res.code, grade }
}

// ---------------------------------------------------------------------------
// Report and gates
// ---------------------------------------------------------------------------

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export function evaluateHygieneGates(
  sessions: ReadonlyArray<Pick<Session, 'arm' | 'grade' | 'dreamUsd'>>,
  roles: Args['roles'],
  reps: number,
): Array<{ gate: string; ok: boolean; detail: string }> {
  const of = (arm: string) => sessions.filter(s => s.arm === arm)
  const passes = (arm: string, check: Check) => of(arm).filter(s => s.grade[check]).length
  const most = Math.ceil((2 * reps) / 3)
  const { base, next, placebo } = roles
  const pair = (check: Check) => `${next} ${passes(next, check)}/${of(next).length}, ${base} ${passes(base, check)}/${of(base).length}`
  const out = [
    { gate: 'S1 controls intact (hard)', ok: passes(next, 'S1') === of(next).length, detail: pair('S1') },
    { gate: 'S2 global never shrinks (hard)', ok: passes(next, 'S2') === of(next).length, detail: pair('S2') },
    ...(['S3', 'E1', 'E2', 'E3', 'E4', 'E5'] as const).map(check => ({ gate: check, ok: passes(next, check) >= most, detail: pair(check) })),
  ]
  const deletes = (arm: string) => of(arm).reduce((n, s) => n + s.grade.deleted, 0)
  out.push({ gate: 'M deletes', ok: deletes(next) > 0, detail: `${next} ${deletes(next)}, ${base} ${deletes(base)}${of(placebo).length ? `, ${placebo} ${deletes(placebo)}` : ''}` })
  const cost = (arm: string) => median(of(arm).flatMap(s => (s.dreamUsd === null ? [] : [s.dreamUsd])))
  out.push({ gate: 'C cost', ok: cost(next) <= cost(base) * 1.5, detail: `median dream $${cost(next).toFixed(3)} against $${cost(base).toFixed(3)}` })
  return out
}

function report(sessions: Session[], arms: string[], args: Args): string {
  const of = (arm: string) => sessions.filter(s => s.arm === arm)
  const rows = CHECKS.map(check => [check, ...arms.map(arm => `${of(arm).filter(s => s.grade[check]).length}/${of(arm).length}`)])
  rows.push(['deleted, total', ...arms.map(arm => String(of(arm).reduce((n, s) => n + s.grade.deleted, 0)))])
  rows.push(['dream $, median', ...arms.map(arm => `$${median(of(arm).flatMap(s => (s.dreamUsd === null ? [] : [s.dreamUsd]))).toFixed(3)}`)])
  const gates = arms.includes(args.roles.next) && arms.includes(args.roles.base) ? evaluateHygieneGates(sessions, args.roles, args.reps) : []
  const failures = sessions.flatMap(s => (s.grade.problems.length ? [`- ${s.arm} r${s.rep}: ${s.grade.problems.join('; ')} (${s.workspace})`] : []))
  return [
    table(['check', ...arms], rows),
    '',
    ...(gates.length ? ['Gates (pre-registered in the header):', table(['gate', 'ok', 'detail'], gates.map(g => [g.gate, g.ok ? 'yes' : 'NO', g.detail])), ''] : []),
    ...(failures.length ? ['Problems:', ...failures] : ['Every session passed every check.']),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export function selfTest(): Array<[string, boolean, string]> {
  const out: Array<[string, boolean, string]> = []
  const before = seedMemories()
  const index = before['team/MEMORY.md']!.trim()
  out.push(['the seeded team index is over the byte cap', Buffer.byteLength(index) > INDEX_BYTES, `${Buffer.byteLength(index)} bytes`])
  const untouched = gradeHygiene(before, before)
  out.push(['a dream that changes nothing keeps S1 and S2', untouched.S1 && untouched.S2, untouched.problems.join('; ')])
  out.push(['…and fails every E check and S3', !untouched.S3 && CHECKS.filter(c => c.startsWith('E')).every(c => !untouched[c]), untouched.problems.join('; ')])
  const ideal = gradeHygiene(before, idealAfter(before))
  out.push(['the ideal dream passes every check', CHECKS.every(c => ideal[c]), ideal.problems.join('; ')])
  out.push(['…and deleted three files', ideal.deleted === 3, String(ideal.deleted)])
  const breaks: Array<[string, Check, (f: Files) => void]> = [
    ['a control deleted', 'S1', f => delete f['team/docs/runbook.md']],
    ['a control rewritten', 'S1', f => (f['feedback-build-first.md'] = fm(['name: feedback-build-first', 'description: x', 'type: feedback'], 'Build sometimes.'))],
    ['a global memory shrunk', 'S2', f => (f['@global/feedback-terse.md'] = fm(['name: feedback-terse', 'description: terse', 'type: feedback'], 'Terse.'))],
    ['a global memory deleted', 'S2', f => delete f['@global/feedback-terse.md']],
    ['one side of the contradiction deleted', 'S3', f => delete f['team/upstream-timeout-a.md']],
    ['the private copy kept', 'E1', f => (f['respostas-em-portugues.md'] = before['respostas-em-portugues.md']!)],
    ['both deploy notes kept', 'E2', f => (f['team/deploy-checklist.md'] = before['team/deploy-checklist.md']!)],
    ['the snapshot kept', 'E3', f => (f['team/bench-cache-2026-08-01.md'] = before['team/bench-cache-2026-08-01.md']!)],
    ['the index left over its cap', 'E4', f => (f['team/MEMORY.md'] = before['team/MEMORY.md']!)],
    ['the stale retry count kept', 'E5', f => (f['project-retry-limit.md'] = before['project-retry-limit.md']!)],
  ]
  for (const [name, check, mutate] of breaks) {
    const after = idealAfter(before)
    mutate(after)
    const g = gradeHygiene(before, after)
    out.push([`${name} fails ${check}`, !g[check], g.problems.join('; ')])
  }
  return out
}

function dryRun(args: Args, arms: string[]): void {
  console.log('memory-hygiene-eval — dry run: nothing is sent to a model\n')
  console.log(`binary: ${args.bin}${existsSync(join(REPO_ROOT, 'dist', 'cli.mjs')) ? '' : '  (dist/cli.mjs is missing — run `bun run build`)'}`)
  console.log(`model ${args.model}, effort ${args.effort}; arms ${arms.join(', ')}; ${arms.length * args.reps} dreams, about $${(arms.length * args.reps * 2).toFixed(0)}–$${(arms.length * args.reps * 4).toFixed(0)}\n`)
  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  const ws = join(dir, 'workspace')
  const roots: Roots = { memory: join(ws, MEMORY_REL), global: join(dir, 'workspace.global') }
  gitWorkspace(ws, PROJECT_FILES, 'chore: import relay-kit 0.1.0')
  writeMemories(roots, seedMemories())
  const gates = selfTest()
  const onDisk = gradeHygiene(seedMemories(), snapshotOf(roots))
  gates.push(['the seeded workspace reads back as written', onDisk.S1 && onDisk.S2 && onDisk.deleted === 0, onDisk.problems.join('; ')])
  gates.push(['the workspace is a repo with one commit', git(ws, 'log', '--format=%s').out.trim() === 'chore: import relay-kit 0.1.0', ws])
  console.log(table(['gate', 'ok', 'detail'], gates.map(([g, ok, d]) => [g, ok ? 'yes' : 'NO', d])))
  if (gates.some(([, ok]) => !ok)) process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const a: Args = {
    reps: 3,
    only: null,
    model: 'claude-opus-5-5',
    effort: 'medium',
    timeoutMs: 20 * 60_000,
    dryRun: false,
    bin: join(REPO_ROOT, 'bin', 'claudin'),
    env: {},
    variants: [],
    roles: { base: 'base', next: 'claudindev', placebo: 'placebo' },
  }
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--model') a.model = v
    else if (k === '--effort') a.effort = v
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--bin') a.bin = v
    else if (k === '--base') a.roles.base = v
    else if (k === '--new') a.roles.next = v
    else if (k === '--placebo') a.roles.placebo = v
    else if (k === '--variant') {
      const colon = v.indexOf(':')
      const label = colon < 0 ? v : v.slice(0, colon)
      const pairs = colon < 0 ? [] : v.slice(colon + 1).split(',').filter(Boolean)
      a.env[label] = Object.fromEntries(pairs.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
      a.variants.push(label)
    } else {
      console.error(`unknown argument ${x}`)
      process.exit(2)
    }
  }
  return a
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const known = ['claudindev', ...args.variants]
  const arms = args.only ?? known
  const unknown = arms.filter(a => !known.includes(a))
  if (unknown.length) {
    console.error(`unknown arm ${unknown.join(', ')} — declare it with --variant=<label>:<ENV>=<value>`)
    process.exit(2)
  }
  if (args.dryRun) {
    dryRun(args, arms)
    return
  }
  if (!existsSync(join(REPO_ROOT, 'dist', 'cli.mjs'))) {
    console.error('dist/cli.mjs is missing — run `bun run build` first: bin/claudin runs the bundle, not the source.')
    process.exit(1)
  }
  const runDir = join(BENCH_ROOT, stamp())
  mkdirSync(runDir, { recursive: true })
  const head = git(REPO_ROOT, 'rev-parse', '--short', 'HEAD').out.trim()
  const meta = { started: new Date().toISOString(), runDir, model: args.model, effort: args.effort, reps: args.reps, arms, armEnv: Object.fromEntries(arms.map(a => [a, args.env[a] ?? {}])), version: `${version(args.bin)} @ ${head}` }
  console.log(`memory-hygiene-eval → ${runDir}\n  ${meta.version}`)
  const sessions: Session[] = []
  const save = () => writeFileSync(join(runDir, 'results.json'), JSON.stringify({ meta, sessions }, null, 1))
  for (let rep = 1; rep <= args.reps; rep++) {
    sessions.push(...(await Promise.all(arms.map(arm => runSession(args, runDir, arm, rep)))))
    save()
  }
  const text = report(sessions, arms, args)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nresults → ${join(runDir, 'results.json')}\nreport  → ${join(runDir, 'report.md')}`)
}

if (import.meta.main) await main()
