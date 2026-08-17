// THE GATE: given the file a session started from, does the bounded-depth
// neighbourhood contain the other files that session went on to touch?
//
// docs/tech/repo-map/ has one lane left — a directed depth-≤2 neighbourhood
// rendered as a LIST OF PATHS (11 priced every other form out). Whether that
// beats the existing path is Gate 1, and it does not need an agent to answer:
// 315 local transcripts already record what an agent actually read and edited
// after it knew where it was starting.
//
// Per session: seed = the first module file touched. Ground truth = every other
// module file touched afterwards. Recall = how much of that the arm returned.
//
// Arms are the neighbourhood at each depth and direction, against four
// baselines the neighbourhood has to beat to be worth building:
//
//   same-dir   the seed's sibling files — free, no graph
//   churn-50   a static top-50 by git churn — free, one `git log`, no seed
//   churn-200  same at 200
//   random-N   sized to match forward d2, per seed — the chance floor
//
// LIMITATION, stated because it bounds the conclusion: one user, one repo, and
// the ground truth is restricted to files the graph could name at all (module
// files). Both favour the graph. See two-layer-viability.md §7.
//
// Usage: bun scripts/bench/repomap/14-oracle-recall.ts [--sessions N]

import { execFileSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { ROOT, ball, buildImportGraph, gitFiles, moduleFiles } from './lib.ts'

const PROJECT_DIR = join(
  homedir(),
  '.claudin',
  'projects',
  `-${ROOT.replace(/^\//, '').replace(/\//g, '-')}`,
)

const tsFiles = moduleFiles(gitFiles(ROOT))
const fileSet = new Set(tsFiles)
const { fwd, rev } = buildImportGraph(ROOT, tsFiles, { skipCommented: false })

// ---------------------------------------------------------------------------
// mine the transcripts
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const PATCH_PATH_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
const ABS_PREFIX = `${ROOT}/`

function normalize(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let p = raw.startsWith(ABS_PREFIX) ? raw.slice(ABS_PREFIX.length) : raw
  p = p.replace(/^\.\//, '')
  return fileSet.has(p) ? p : null
}

function targetsOf(name: string, input: Record<string, unknown>): string[] {
  if (name === 'Read' || name === 'FileRead' || WRITE_TOOLS.has(name)) {
    const p = normalize(input.file_path)
    return p === null ? [] : [p]
  }
  if (name === 'apply_patch') {
    const text = typeof input.patchText === 'string' ? input.patchText : ''
    const out: string[] = []
    PATCH_PATH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATCH_PATH_RE.exec(text))) {
      const p = normalize(m[1]!.trim())
      if (p !== null) out.push(p)
    }
    return out
  }
  return []
}

type Session = { id: string; seed: string; truth: Set<string>; touched: number }

const sessions: Session[] = []
let parsed = 0
let skippedLines = 0

const files = readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl'))
for (const f of files) {
  let raw: string
  try {
    raw = readFileSync(join(PROJECT_DIR, f), 'utf8')
  } catch {
    continue
  }
  parsed++
  const order: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0 || !line.includes('"tool_use"')) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      skippedLines++
      continue
    }
    if (rec.isSidechain === true) continue
    const content = rec?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      for (const t of targetsOf(block.name, input)) order.push(t)
    }
  }
  if (order.length === 0) continue
  const seed = order[0]!
  const truth = new Set(order.slice(1).filter(p => p !== seed))
  if (truth.size === 0) continue
  sessions.push({ id: f.replace(/\.jsonl$/, ''), seed, truth, touched: order.length })
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

const log = execFileSync('git', ['log', '-2000', '--name-only', '--pretty=format:'], {
  cwd: ROOT,
  maxBuffer: 256 * 1024 * 1024,
  encoding: 'utf8',
})
const churn = new Map<string, number>()
for (const line of log.split('\n')) {
  const p = line.trim()
  if (p.length === 0 || !fileSet.has(p)) continue
  churn.set(p, (churn.get(p) ?? 0) + 1)
}
const byChurn = [...churn.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
const churn50 = new Set(byChurn.slice(0, 50).map(e => e[0]))
const churn200 = new Set(byChurn.slice(0, 200).map(e => e[0]))

const byDir = new Map<string, string[]>()
for (const p of tsFiles) {
  const d = dirname(p)
  if (!byDir.has(d)) byDir.set(d, [])
  byDir.get(d)!.push(p)
}

// deterministic PRNG so the chance floor is reproducible
let rngState = 0x2f6e2b1
const rand = () => {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff
  return rngState / 0x7fffffff
}
const sorted = [...tsFiles].sort()
function randomSet(n: number, exclude: string): Set<string> {
  const out = new Set<string>()
  let guard = 0
  while (out.size < n && guard++ < n * 20) {
    const p = sorted[Math.floor(rand() * sorted.length)]!
    if (p !== exclude) out.add(p)
  }
  return out
}

type Arm = { label: string; of: (seed: string) => Set<string> }
const union = (...sets: Array<Set<string>>) => {
  const out = new Set<string>()
  for (const s of sets) for (const p of s) out.add(p)
  return out
}
const sameDir = (s: string) => new Set((byDir.get(dirname(s)) ?? []).filter(p => p !== s))
const ARMS: Arm[] = [
  { label: 'fwd d1', of: s => ball(s, 1, [fwd]) },
  { label: 'fwd d2', of: s => ball(s, 2, [fwd]) },
  { label: 'rev d1', of: s => ball(s, 1, [rev]) },
  { label: 'rev d2', of: s => ball(s, 2, [rev]) },
  { label: 'undir d1', of: s => ball(s, 1, [fwd, rev]) },
  { label: 'undir d2', of: s => ball(s, 2, [fwd, rev]) },
  { label: 'same-dir', of: sameDir },
  { label: '+ rev d1', of: s => union(sameDir(s), ball(s, 1, [rev])) },
  { label: '+ undir d1', of: s => union(sameDir(s), ball(s, 1, [fwd, rev])) },
  { label: '+ undir d2', of: s => union(sameDir(s), ball(s, 2, [fwd, rev])) },
  { label: 'churn-50', of: s => new Set([...churn50].filter(p => p !== s)) },
  { label: 'churn-200', of: s => new Set([...churn200].filter(p => p !== s)) },
  { label: 'random=fwd d2', of: s => randomSet(ball(s, 2, [fwd]).size, s) },
]

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

const median = (xs: number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]!
}
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const PATH_TOK = 34 / 4

console.log(`transcripts read: ${parsed}   unparsable lines: ${skippedLines}`)
console.log(`sessions with a seed and ≥1 later module file: ${sessions.length}`)
console.log(
  `ground truth per session: p50 ${median(sessions.map(s => s.truth.size))} files, ` +
    `mean ${mean(sessions.map(s => s.truth.size)).toFixed(1)}\n`,
)

console.log('arm             answer(files)      recall        hit≥1    recall per 1k tok')
console.log('                  p50    mean     p50    mean        %          (mean)')
for (const arm of ARMS) {
  const sizes: number[] = []
  const recalls: number[] = []
  const perTok: number[] = []
  let anyHit = 0
  for (const s of sessions) {
    const answer = arm.of(s.seed)
    let hit = 0
    for (const t of s.truth) if (answer.has(t)) hit++
    const recall = hit / s.truth.size
    sizes.push(answer.size)
    recalls.push(recall)
    const tok = answer.size * PATH_TOK
    perTok.push(tok === 0 ? 0 : (recall * 1000) / tok)
    if (hit > 0) anyHit++
  }
  console.log(
    `${arm.label.padEnd(14)} ${String(median(sizes)).padStart(6)} ${mean(sizes).toFixed(0).padStart(7)}  ` +
      `${(median(recalls) * 100).toFixed(1).padStart(6)}% ${(mean(recalls) * 100).toFixed(1).padStart(6)}%  ` +
      `${((anyHit / sessions.length) * 100).toFixed(1).padStart(7)}%  ` +
      `${mean(perTok).toFixed(2).padStart(12)}`,
  )
}

// How much of the answer is wasted? Precision on the arm that matters.
console.log('\nprecision (share of the answer that was actually touched):')
for (const label of ['fwd d2', 'rev d2', 'undir d1', 'same-dir', '+ undir d1']) {
  const arm = ARMS.find(a => a.label === label)!
  const precisions: number[] = []
  for (const s of sessions) {
    const answer = arm.of(s.seed)
    if (answer.size === 0) continue
    let hit = 0
    for (const t of s.truth) if (answer.has(t)) hit++
    precisions.push(hit / answer.size)
  }
  console.log(
    `  ${label.padEnd(12)} p50 ${(median(precisions) * 100).toFixed(1)}%  mean ${(mean(precisions) * 100).toFixed(1)}%`,
  )
}
