#!/usr/bin/env bun
/**
 * Memory-write A/B — does a prompt arm still save memories the way the memory
 * system needs them? The session bench never writes a memory, so a regression
 * there would not show in it: memory saved in the wrong place, a frontmatter
 * missing a field, no line in the index.
 *
 * Written for the arm that took the write-time rules out of the v2 memory
 * section (memoryFormatGuard.ts hands them back when a write breaks them; team
 * memory `claude-code-2.1.284-wire-diff`). Run /tmp/memory-write-ab/20260929-230343:
 * 12/12 in every arm, the arm $0.109 a session against $0.119 base and $0.117
 * placebo; it is the default since. Any later change to a memory prompt goes
 * through here the same way, as a `--variant`.
 *
 * Four requests, each its own headless `-p` session (the third is two turns,
 * the second `--resume`s the first):
 *   pnpm        "lembra que neste projeto a gente usa pnpm e não npm"
 *   staging     "remember that the staging API lives at https://staging.example.test"
 *   correction  a default export asked for, then corrected — should become a
 *               `feedback` memory
 *   decision    a team decision with a rejected alternative — should land in
 *               `team/decisions/` with its fields
 *   preference  a preference of the user's that holds in any project —
 *               should land in the global memory dir (paths.ts
 *               getGlobalMemPath), or the private one in an arm that turns it
 *               off with CLAUDIN_GLOBAL_MEMORY=0
 *
 * Each session gets a fresh workspace under /tmp/memory-write-ab/<stamp>/: a
 * git repo with one pinned commit and an empty `.claudin/memory/team/`, so the
 * project-local memory starts empty (it relies on `autoMemoryProjectLocal`
 * being left at its default), and a global memory dir of its own beside it,
 * `<label>.global/`, handed over as `--settings {"autoMemoryGlobalDirectory":…}`
 * so no session reads or writes the real ~/.claudin/memory/. Every session is
 * graded from the files on disk,
 * by checks written here independently of the guard:
 *   where        the memory carrying the fact is in a directory its kind allows
 *   frontmatter  `name`, `description`, a valid `type`; never `type: user` in
 *                the team dir; a category's type, and a decision's `scope:`
 *                and `impact:`; with the global dir on, `type: user` only
 *                there, and neither `type: project` nor `paths:` in it
 *   index        its directory's MEMORY.md links to it
 *   single       the fact lives in exactly one file (one fact per file, no
 *                duplicate across the directories)
 * A session passes when all four hold. Cost is the CLI's own `total_cost_usd`
 * from the stream-json result; the stream is also searched for the guard's
 * refusals and index notes, so the arm's mechanism can be seen to fire.
 *
 * Usage:
 *   bun scripts/bench/ab/memory-write-ab.ts --dry-run       # plan + grader self-test, no tokens
 *   bun scripts/bench/ab/memory-write-ab.ts --reps=3 --variant=placebo:CLAUDIN_BENCH_PLACEBO=1 \
 *     --variant=<label>:<ENV>=<value> --only=claudindev,placebo,<label>
 *
 * `claudindev` is this checkout's `bin/claudin` with no extra variable; a
 * `--variant=<label>:<ENV>=<value>[,<ENV>=<value>]` is the same binary with
 * those set. Run `bun run build` first: the binary runs the bundle. The arms
 * of one (request, rep) run concurrently; host CLAUDECODE / CLAUDE_CODE_* /
 * CLAUDIN_* variables are stripped (session-cache-ab.ts `spawnCollect`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { REPO_ROOT } from '../../repoRoot'
import { parseJsonl } from './cliUsage'
import { git, spawnCollect, stamp, table, version } from './session-cache-ab'

const BENCH_ROOT = '/tmp/memory-write-ab'
const MEMORY_REL = join('.claudin', 'memory')
const INDEX = 'MEMORY.md'
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
const IMPACTS = ['structural', 'functional', 'rejected'] as const
/** A category directory of the team dir and the `type` its memories carry. */
const CATEGORY_TYPES: Record<string, string> = { decisions: 'project', bugs: 'project', docs: 'reference' }
/** The global memory dir, as a prefix of a memory's path relative to the memory root. */
const GLOBAL = '@global/'

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type RequestId = 'pnpm' | 'staging' | 'correction' | 'decision' | 'preference'

type Request = {
  id: RequestId
  /** One `-p` per turn; a later turn resumes the session. */
  turns: string[]
  /**
   * Directories the memory may be in, relative to the memory root: '' private,
   * 'team/' the team root, GLOBAL the global memory dir.
   */
  dirs: readonly string[]
  /** `dirs` when the session has the global dir on, where it differs. */
  dirsWithGlobal?: readonly string[]
  /** The fact, as the memory's text must carry it. */
  fact: RegExp
  /** The `type` the memory must have, when the request decides it. */
  type?: (typeof MEMORY_TYPES)[number]
}

const REQUESTS: readonly Request[] = [
  {
    id: 'pnpm',
    turns: ['lembra que neste projeto a gente usa pnpm e não npm'],
    dirs: ['', 'team/'],
    fact: /pnpm/i,
  },
  {
    id: 'staging',
    turns: ['remember that the staging API lives at https://staging.example.test'],
    dirs: ['', 'team/', 'team/docs/'],
    fact: /staging\.example\.test/,
  },
  {
    id: 'correction',
    turns: [
      'cria src/greet.ts com um export default de uma função greet(name: string) que retorna `Olá, ${name}!`',
      'não, aqui a gente nunca usa default exports — sempre named exports',
    ],
    dirs: ['', 'team/'],
    fact: /default export|named export|export default/i,
    type: 'feedback',
  },
  {
    id: 'decision',
    turns: [
      'registra na memória do time a decisão: removemos o cache de disco porque corrompia em NFS; alternativa rejeitada: lock de arquivo',
    ],
    dirs: ['team/decisions/'],
    fact: /NFS/i,
  },
  {
    id: 'preference',
    turns: ['lembra que eu prefiro respostas mais elaboradas, com o raciocínio explicado passo a passo'],
    dirs: [''],
    dirsWithGlobal: [GLOBAL],
    fact: /elaborad|elaborat|detalhad|detailed|thorough|passo a passo|step[- ]by[- ]step/i,
  },
]

const allowedDirs = (request: Request, globalOn: boolean): readonly string[] =>
  globalOn ? (request.dirsWithGlobal ?? request.dirs) : request.dirs

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const PROJECT_FILES: Record<string, string> = {
  'README.md': '# greet-kit\n\nA tiny TypeScript helper library.\n',
  'package.json': `${JSON.stringify({ name: 'greet-kit', version: '0.1.0', type: 'module', scripts: { test: 'bun test' } }, null, 2)}\n`,
  'src/index.ts': "export const VERSION = '0.1.0'\n",
}

/** A git repo with one pinned commit and an empty project-local team memory dir. */
function makeWorkspace(dir: string): void {
  for (const [rel, content] of Object.entries(PROJECT_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const steps: string[][] = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', '.git/no-hooks'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'chore: import greet-kit 0.1.0'],
  ]
  for (const step of steps) {
    const r = git(dir, ...step)
    if (!r.ok) throw new Error(`git ${step.join(' ')} failed in ${dir}: ${r.out}`)
  }
  mkdirSync(join(dir, MEMORY_REL, 'team'), { recursive: true })
}

// ---------------------------------------------------------------------------
// Grading — the guard's checks, written again from the memory docs
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const KEY_RE = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/
const QUOTED_RE = /^(["'])(.*)\1$/
const LINK_RE = /\]\(\s*<?([^)\s>]+)/g
const CATEGORY_PATH_RE = /^team\/(decisions|bugs|docs)\/[^/]+\.md$/

/** Top-level `key: value` pairs of the frontmatter, or null when there is none. */
function frontmatterOf(text: string): Record<string, string> | null {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const k = KEY_RE.exec(line)
    if (k) out[k[1]!] = k[2]!.trim().replace(QUOTED_RE, '$2').trim()
  }
  return out
}

/**
 * Where a session's memory lives: the project-local memory root, and the
 * global dir when the session has one on (null in an arm that turns it off).
 */
type MemoryRoots = { root: string; globalRoot: string | null }

const isGlobalRel = (rel: string): boolean => rel.startsWith(GLOBAL)

/** The file at `rel` — relative to the memory root, or GLOBAL-prefixed. */
function absOf(roots: MemoryRoots, rel: string): string {
  return isGlobalRel(rel) ? join(roots.globalRoot!, rel.slice(GLOBAL.length)) : join(roots.root, rel)
}

/** What the frontmatter of the memory at `rel` (relative to the memory root) misses. */
function frontmatterProblems(rel: string, text: string, globalOn: boolean): string[] {
  const fm = frontmatterOf(text)
  if (!fm) return ['no frontmatter']
  const problems: string[] = []
  if (!fm.name) problems.push('no name')
  if (!fm.description) problems.push('no description')
  const type = fm.type ?? ''
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) problems.push(`type "${type}"`)
  if (rel.startsWith('team/') && type === 'user') problems.push('user memory in the team dir')
  if (isGlobalRel(rel)) {
    if (type === 'project') problems.push('project memory in the global dir')
    if ('paths' in fm) problems.push('paths: in the global dir')
  } else if (globalOn && type === 'user') {
    problems.push('user memory outside the global dir')
  }
  const category = CATEGORY_PATH_RE.exec(rel)?.[1]
  if (category) {
    if (type !== CATEGORY_TYPES[category]) problems.push(`${category} memory of type "${type}"`)
    if (category === 'decisions') {
      if (!fm.scope) problems.push('no scope')
      if (!(IMPACTS as readonly string[]).includes(fm.impact ?? '')) problems.push(`impact "${fm.impact ?? ''}"`)
    }
  }
  return problems
}

/** Every memory file under `root`, relative to it, indexes excluded. */
function memoryFiles(root: string, sub = ''): string[] {
  const dir = join(root, sub)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) return memoryFiles(root, rel)
    return entry.name.endsWith('.md') && entry.name !== INDEX ? [rel] : []
  })
}

/** Every memory file of the session: the memory root's, then the global dir's under GLOBAL. */
function allMemoryFiles(roots: MemoryRoots): string[] {
  return [
    ...memoryFiles(roots.root),
    ...(roots.globalRoot === null ? [] : memoryFiles(roots.globalRoot).map(rel => `${GLOBAL}${rel}`)),
  ]
}

/** Whether the index of the directory holding `rel` links to it. */
function isIndexed(roots: MemoryRoots, rel: string): boolean {
  const indexDir = isGlobalRel(rel)
    ? roots.globalRoot!
    : rel.startsWith('team/')
      ? join(roots.root, 'team')
      : roots.root
  const indexPath = join(indexDir, INDEX)
  if (!existsSync(indexPath)) return false
  const target = resolve(absOf(roots, rel))
  for (const match of readFileSync(indexPath, 'utf8').matchAll(LINK_RE)) {
    const link = match[1]!.split('#')[0]!
    if (link && resolve(indexDir, link) === target) return true
  }
  return false
}

const dirOf = (rel: string): string =>
  isGlobalRel(rel) ? GLOBAL : rel.includes('/') ? `${dirname(rel)}/` : ''

type Grade = {
  /** The memory carrying the fact (relative to the memory root), or null. */
  file: string | null
  where: boolean
  frontmatter: boolean
  index: boolean
  single: boolean
  pass: boolean
  /** Every memory file the session left. */
  files: number
  problems: string[]
}

function gradeMemory(roots: MemoryRoots, request: Request): Grade {
  const globalOn = roots.globalRoot !== null
  const dirs = allowedDirs(request, globalOn)
  const all = allMemoryFiles(roots)
  const carrying = all.filter(rel => request.fact.test(readFileSync(absOf(roots, rel), 'utf8')))
  // The one in an allowed directory, when there is one, is the one graded.
  const file = carrying.find(rel => dirs.includes(dirOf(rel))) ?? carrying[0] ?? null
  if (!file) {
    return { file, where: false, frontmatter: false, index: false, single: false, pass: false, files: all.length, problems: ['no memory carries the fact'] }
  }
  const text = readFileSync(absOf(roots, file), 'utf8')
  const type = frontmatterOf(text)?.type
  const formatProblems = frontmatterProblems(file, text, globalOn)
  const typeOk = !request.type || type === request.type
  const frontmatter = formatProblems.length === 0 && typeOk
  const where = dirs.includes(dirOf(file))
  const index = isIndexed(roots, file)
  const single = carrying.length === 1
  const problems = [...formatProblems]
  if (!typeOk) problems.push(`expected type "${request.type}", got "${type ?? ''}"`)
  if (!where) problems.push(`in "${dirOf(file) || '(private root)'}"`)
  if (!index) problems.push('not in its index')
  if (!single) problems.push(`the fact is in ${carrying.length} files`)
  return { file, where, frontmatter, index, single, pass: where && frontmatter && index && single, files: all.length, problems }
}

// ---------------------------------------------------------------------------
// Running a session
// ---------------------------------------------------------------------------

type Arm = string

type Args = {
  reps: number
  only: Arm[] | null
  model: string
  effort: string
  maxTurns: number
  budgetUsd: number
  timeoutMs: number
  dryRun: boolean
  bin: string
  env: Record<Arm, Record<string, string>>
  variants: Arm[]
}

type Session = {
  arm: Arm
  request: RequestId
  rep: number
  workspace: string
  sessionId: string | null
  costUsd: number
  apiCalls: number
  exitCodes: number[]
  /** memoryFormatGuard.ts refusals and index notes seen in the stream. */
  refusals: number
  indexNotes: number
  grade: Grade
}

const REFUSAL_MARK = 'Memory file not written:'
const INDEX_NOTE_MARK = 'memory index yet'

function turnArgs(args: Args, prompt: string, resumeId: string | null, globalDir: string): string[] {
  return [
    '-p',
    prompt,
    '--model',
    args.model,
    '--effort',
    args.effort,
    '--max-turns',
    String(args.maxTurns),
    '--max-budget-usd',
    String(args.budgetUsd),
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    // The session's own global memory dir: never the real ~/.claudin/memory/.
    '--settings',
    JSON.stringify({ autoMemoryGlobalDirectory: globalDir }),
    ...(resumeId ? ['--resume', resumeId] : []),
  ]
}

/**
 * Tool results whose text carries `mark`, counted once each: a refusal's text
 * is also echoed in the event's `tool_use_result`, so a substring count over
 * the raw stream reads one refusal as two.
 */
function count(events: ReadonlyArray<Record<string, unknown>>, mark: string): number {
  const ids = new Set<string>()
  for (const e of events) {
    if (e.type !== 'user') continue
    const content = (e.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: unknown; tool_use_id?: unknown; content?: unknown }>) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      if (JSON.stringify(block.content ?? '').includes(mark)) ids.add(block.tool_use_id)
    }
  }
  return ids.size
}

async function runSession(args: Args, runDir: string, arm: Arm, request: Request, rep: number): Promise<Session> {
  const label = `${arm}-${request.id}-r${rep}`
  const ws = join(runDir, label)
  const globalDir = join(runDir, `${label}.global`)
  makeWorkspace(ws)
  let sessionId: string | null = null
  let costUsd = 0
  let refusals = 0
  let indexNotes = 0
  const exitCodes: number[] = []
  const messageIds = new Set<string>()
  for (const [i, prompt] of request.turns.entries()) {
    if (i > 0 && !sessionId) break
    const res = await spawnCollect(args.bin, turnArgs(args, prompt, sessionId, globalDir), ws, join(runDir, `${label}.t${i + 1}`), args.timeoutMs, args.env[arm] ?? {})
    exitCodes.push(res.code)
    const events = parseJsonl(res.stdout)
    const result = events.findLast(e => e.type === 'result')
    if (typeof result?.total_cost_usd === 'number') costUsd += result.total_cost_usd
    sessionId ??= typeof result?.session_id === 'string' ? result.session_id : null
    for (const e of events) {
      const message = e.message as { id?: unknown } | undefined
      if (e.type === 'assistant' && typeof message?.id === 'string') messageIds.add(message.id)
    }
    refusals += count(events, REFUSAL_MARK)
    indexNotes += count(events, INDEX_NOTE_MARK)
  }
  const globalOn = args.env[arm]?.CLAUDIN_GLOBAL_MEMORY !== '0'
  const grade = gradeMemory({ root: join(ws, MEMORY_REL), globalRoot: globalOn ? globalDir : null }, request)
  console.log(
    `[${label}] ${grade.pass ? 'PASS' : 'fail'} ${grade.file ?? '(no memory)'} — $${costUsd.toFixed(3)}, ${messageIds.size} API calls` +
      (refusals || indexNotes ? `, guard: ${refusals} refused / ${indexNotes} index notes` : '') +
      (grade.problems.length ? ` — ${grade.problems.join('; ')}` : ''),
  )
  return { arm, request: request.id, rep, workspace: ws, sessionId, costUsd, apiCalls: messageIds.size, exitCodes, refusals, indexNotes, grade }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const CHECKS = ['pass', 'where', 'frontmatter', 'index', 'single'] as const

function report(sessions: Session[], arms: Arm[]): string {
  const of = (arm: Arm, request?: RequestId) =>
    sessions.filter(s => s.arm === arm && (request === undefined || s.request === request))
  const rows: string[][] = []
  for (const request of REQUESTS) {
    for (const check of CHECKS) {
      rows.push([
        check === 'pass' ? request.id : '',
        check,
        ...arms.map(arm => {
          const mine = of(arm, request.id)
          return `${mine.filter(s => s.grade[check]).length}/${mine.length}`
        }),
      ])
    }
  }
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
  rows.push(
    ['all', 'pass', ...arms.map(arm => `${of(arm).filter(s => s.grade.pass).length}/${of(arm).length}`)],
    ['', 'cost, mean/session', ...arms.map(arm => `$${mean(of(arm).map(s => s.costUsd)).toFixed(3)}`)],
    ['', 'API calls, mean', ...arms.map(arm => mean(of(arm).map(s => s.apiCalls)).toFixed(1))],
    ['', 'guard refusals', ...arms.map(arm => String(of(arm).reduce((n, s) => n + s.refusals, 0)))],
    ['', 'index notes', ...arms.map(arm => String(of(arm).reduce((n, s) => n + s.indexNotes, 0)))],
  )
  const [base, ...rest] = arms
  const passes = (arm: Arm) => of(arm).filter(s => s.grade.pass).length
  const verdicts = rest.map(arm =>
    `- ${arm}: ${passes(arm)} passes against ${base}'s ${passes(base!)} — ${passes(arm) >= passes(base!) ? 'at least as good' : 'BELOW the baseline'}`,
  )
  const failures = sessions
    .filter(s => !s.grade.pass)
    .map(s => `- ${s.arm} ${s.request} r${s.rep}: ${s.grade.problems.join('; ')} (${s.workspace})`)
  return [
    table(['request', 'check', ...arms], rows),
    '',
    ...(verdicts.length ? ['Gate (an arm passes at least as often as the first arm):', ...verdicts, ''] : []),
    ...(failures.length ? ['Failed sessions:', ...failures] : ['Every session passed.']),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Dry run — the plan, and the grader on hand-written workspaces
// ---------------------------------------------------------------------------

type Fixture = Record<string, string>

const fm = (lines: string[], body: string) => `---\n${lines.join('\n')}\n---\n\n${body}\n`

/** One memory tree per request that must pass. */
const GOOD: Record<RequestId, Fixture> = {
  pnpm: {
    'team/uses-pnpm.md': fm(['name: uses-pnpm', 'description: this project installs with pnpm, never npm', 'type: project'], 'Use pnpm, never npm.'),
    'team/MEMORY.md': '- [Uses pnpm](uses-pnpm.md) — never npm\n',
  },
  staging: {
    'staging-api.md': fm(['name: staging-api', 'description: where the staging API lives', 'type: reference'], 'Staging API: https://staging.example.test'),
    'MEMORY.md': '- [Staging API](staging-api.md) — https://staging.example.test\n',
  },
  correction: {
    'team/named-exports-only.md': fm(
      ['name: named-exports-only', 'description: "never default exports: always named exports"', 'type: feedback'],
      'Never use default exports — always named exports.\n\n**Why:** corrected on 2026-09-29.\n**How to apply:** `export function`.',
    ),
    'team/MEMORY.md': '- [Named exports only](./named-exports-only.md) — no default exports\n',
  },
  decision: {
    'team/decisions/drop-disk-cache.md': fm(
      ['name: drop-disk-cache', 'description: the disk cache was removed; it corrupted on NFS', 'type: project', 'scope: cache', 'impact: rejected', 'paths:', '  - "src/cache/**"'],
      '**Decision:** no disk cache.\n**Why:** it corrupted on NFS.\n**What changes for a teammate:** nothing to clear.\n**Rejected:** a file lock.\n**Evidence:** 2026-09-29.',
    ),
    'team/MEMORY.md': '## Decisions\n- [Drop the disk cache](decisions/drop-disk-cache.md) — NFS corruption\n',
  },
  preference: {
    [`${GLOBAL}prefers-detailed-answers.md`]: fm(
      ['name: prefers-detailed-answers', 'description: the user wants elaborate answers with the reasoning explained', 'type: feedback'],
      'Give elaborate answers, reasoning explained step by step.\n\n**Why:** the user asked for it.\n**How to apply:** every answer, in any project.',
    ),
    [`${GLOBAL}MEMORY.md`]: '- [Detailed answers](prefers-detailed-answers.md) — reasoning step by step\n',
  },
}

/** Memory trees that must fail, each on the check it names. */
const BAD: Array<{ request: RequestId; name: string; fails: (typeof CHECKS)[number]; files: Fixture }> = [
  {
    request: 'pnpm',
    name: 'no type',
    fails: 'frontmatter',
    files: { 'uses-pnpm.md': fm(['name: uses-pnpm', 'description: pnpm, not npm'], 'Use pnpm.'), 'MEMORY.md': '- [pnpm](uses-pnpm.md) — x\n' },
  },
  {
    request: 'staging',
    name: 'no index line',
    fails: 'index',
    files: { 'staging-api.md': fm(['name: staging-api', 'description: staging', 'type: reference'], 'https://staging.example.test'), 'MEMORY.md': '- [Other](other-staging-api.md) — x\n' },
  },
  {
    request: 'correction',
    name: 'the fact in both directories',
    fails: 'single',
    files: {
      'named-exports.md': fm(['name: named-exports', 'description: named exports', 'type: feedback'], 'No default exports.'),
      'MEMORY.md': '- [Named](named-exports.md) — x\n',
      'team/named-exports.md': fm(['name: named-exports', 'description: named exports', 'type: feedback'], 'No default exports.'),
      'team/MEMORY.md': '- [Named](named-exports.md) — x\n',
    },
  },
  {
    request: 'correction',
    name: 'a project memory where feedback was due',
    fails: 'frontmatter',
    files: { 'named-exports.md': fm(['name: named-exports', 'description: named exports', 'type: project'], 'No default exports.'), 'MEMORY.md': '- [Named](named-exports.md) — x\n' },
  },
  {
    request: 'decision',
    name: 'a decision at the team root',
    fails: 'where',
    files: {
      'team/drop-disk-cache.md': GOOD.decision['team/decisions/drop-disk-cache.md']!,
      'team/MEMORY.md': '- [Drop](drop-disk-cache.md) — x\n',
    },
  },
  {
    request: 'decision',
    name: 'a decision without impact',
    fails: 'frontmatter',
    files: {
      'team/decisions/drop-disk-cache.md': fm(['name: drop-disk-cache', 'description: no disk cache', 'type: project', 'scope: cache'], 'NFS corruption.'),
      'team/MEMORY.md': '- [Drop](decisions/drop-disk-cache.md) — x\n',
    },
  },
  { request: 'pnpm', name: 'nothing saved', fails: 'pass', files: {} },
  {
    request: 'pnpm',
    name: 'a project fact in the global dir',
    fails: 'where',
    files: {
      [`${GLOBAL}uses-pnpm.md`]: fm(['name: uses-pnpm', 'description: pnpm, not npm', 'type: project'], 'Use pnpm.'),
      [`${GLOBAL}MEMORY.md`]: '- [pnpm](uses-pnpm.md) — x\n',
    },
  },
  {
    request: 'preference',
    name: 'a preference kept private as a user memory',
    fails: 'where',
    files: {
      'prefers-detailed-answers.md': fm(['name: detailed', 'description: detailed answers', 'type: user'], 'Elaborate answers.'),
      'MEMORY.md': '- [Detailed](prefers-detailed-answers.md) — x\n',
    },
  },
  {
    request: 'preference',
    name: 'a global memory with paths:',
    fails: 'frontmatter',
    files: {
      [`${GLOBAL}detailed.md`]: fm(['name: detailed', 'description: detailed answers', 'type: feedback', 'paths:', '  - "src/**"'], 'Elaborate answers.'),
      [`${GLOBAL}MEMORY.md`]: '- [Detailed](detailed.md) — x\n',
    },
  },
]

function writeFixture(roots: MemoryRoots, files: Fixture): void {
  mkdirSync(join(roots.root, 'team'), { recursive: true })
  if (roots.globalRoot !== null) mkdirSync(roots.globalRoot, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = absOf(roots, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** A fixture's two roots: a memory root, and a global dir beside it (or none). */
const fixtureRoots = (dir: string, globalOn = true): MemoryRoots => ({
  root: join(dir, 'memory'),
  globalRoot: globalOn ? join(dir, 'global') : null,
})

const requestById = (id: RequestId): Request => REQUESTS.find(r => r.id === id)!

function dryRun(args: Args, arms: Arm[]): void {
  const sessions = arms.length * REQUESTS.length * args.reps
  const processes = arms.length * args.reps * REQUESTS.reduce((n, r) => n + r.turns.length, 0)
  console.log('memory-write-ab — dry run: nothing is sent to a model\n')
  console.log(`binary: ${args.bin}${existsSync(join(REPO_ROOT, 'dist', 'cli.mjs')) ? '' : '  (dist/cli.mjs is missing — run `bun run build`)'}`)
  console.log(`model ${args.model}, effort ${args.effort}; each CLI run capped at ${args.maxTurns} turns and $${args.budgetUsd}`)
  console.log(`arms: ${arms.map(a => `${a}${Object.keys(args.env[a] ?? {}).length ? ` (${Object.entries(args.env[a]!).map(([k, v]) => `${k}=${v}`).join(' ')})` : ''}`).join(', ')}`)
  console.log(`${sessions} sessions (${processes} CLI runs), about $${(sessions * 0.12).toFixed(2)}–$${(sessions * 0.25).toFixed(2)}\n`)
  for (const r of REQUESTS) {
    const where = (dirs: readonly string[]) => dirs.map(d => d || '(private root)').join(' | ')
    console.log(
      `  ${r.id.padEnd(10)} → ${where(allowedDirs(r, true))}${r.dirsWithGlobal ? ` (global off: ${where(r.dirs)})` : ''}${r.type ? `, type ${r.type}` : ''}`,
    )
    for (const t of r.turns) console.log(`               "${t}"`)
  }
  console.log(`\nfirst command: ${args.bin} ${turnArgs(args, REQUESTS[0]!.turns[0]!, null, '<label>.global').map(a => (a.includes(' ') || a.includes('"') ? JSON.stringify(a) : a)).join(' ')}\n`)

  const dir = join(BENCH_ROOT, `dry-run-${stamp()}`)
  const gates: Array<[string, boolean, string]> = []
  const ws = join(dir, 'workspace')
  makeWorkspace(ws)
  const log = git(ws, 'log', '--format=%s').out.trim()
  gates.push(['a workspace is a repo with one commit and an empty team dir', log === 'chore: import greet-kit 0.1.0' && memoryFiles(join(ws, MEMORY_REL)).length === 0 && existsSync(join(ws, MEMORY_REL, 'team')), log])
  gates.push(['an empty workspace fails every request', REQUESTS.every(r => !gradeMemory({ root: join(ws, MEMORY_REL), globalRoot: join(dir, 'empty-global') }, r).pass), 'no memory'])
  for (const r of REQUESTS) {
    const roots = fixtureRoots(join(dir, `good-${r.id}`))
    writeFixture(roots, GOOD[r.id])
    const g = gradeMemory(roots, r)
    gates.push([`good ${r.id} passes`, g.pass, g.problems.join('; ') || g.file || ''])
  }
  {
    // With the global dir off, a preference is private, as before it existed.
    const roots = fixtureRoots(join(dir, 'good-preference-global-off'), false)
    writeFixture(roots, {
      'prefers-detailed-answers.md': fm(['name: detailed', 'description: detailed answers', 'type: user'], 'Elaborate answers.'),
      'MEMORY.md': '- [Detailed](prefers-detailed-answers.md) — x\n',
    })
    const g = gradeMemory(roots, requestById('preference'))
    gates.push(['good preference with the global dir off passes in the private root', g.pass, g.problems.join('; ') || g.file || ''])
  }
  for (const [i, bad] of BAD.entries()) {
    const roots = fixtureRoots(join(dir, `bad-${i}`))
    writeFixture(roots, bad.files)
    const g = gradeMemory(roots, requestById(bad.request))
    gates.push([`bad ${bad.request} (${bad.name}) fails on ${bad.fails}`, !g.pass && !g[bad.fails], g.problems.join('; ')])
  }
  console.log(`grader self-test in ${dir}\n`)
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
    maxTurns: 12,
    budgetUsd: 2,
    timeoutMs: 10 * 60_000,
    dryRun: false,
    bin: join(REPO_ROOT, 'bin', 'claudin'),
    env: {},
    variants: [],
  }
  for (const x of argv) {
    const [k, v = ''] = x.split(/=(.*)/s, 2) as [string, string?]
    if (k === '--dry-run') a.dryRun = true
    else if (k === '--reps') a.reps = Number(v)
    else if (k === '--only') a.only = v.split(',').filter(Boolean)
    else if (k === '--model') a.model = v
    else if (k === '--effort') a.effort = v
    else if (k === '--max-turns') a.maxTurns = Number(v)
    else if (k === '--budget') a.budgetUsd = Number(v)
    else if (k === '--timeout-min') a.timeoutMs = Number(v) * 60_000
    else if (k === '--bin') a.bin = v
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
  const meta = {
    started: new Date().toISOString(),
    runDir,
    model: args.model,
    effort: args.effort,
    reps: args.reps,
    arms,
    armEnv: Object.fromEntries(arms.map(a => [a, args.env[a] ?? {}])),
    version: `${version(args.bin)} @ ${head}`,
  }
  console.log(`memory-write-ab → ${runDir}\n  ${meta.version}`)
  const sessions: Session[] = []
  const save = () => writeFileSync(join(runDir, 'results.json'), JSON.stringify({ meta, sessions }, null, 1))
  for (let rep = 1; rep <= args.reps; rep++) {
    for (const request of REQUESTS) {
      sessions.push(...(await Promise.all(arms.map(arm => runSession(args, runDir, arm, request, rep)))))
      save()
    }
  }
  const text = report(sessions, arms)
  writeFileSync(join(runDir, 'report.md'), text)
  console.log(`\n${text}\n\nresults → ${join(runDir, 'results.json')}\nreport  → ${join(runDir, 'report.md')}`)
}

if (import.meta.main) await main()
