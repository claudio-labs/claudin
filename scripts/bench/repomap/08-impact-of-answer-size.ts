// How big is the answer to `impact_of(file)` — the reverse-import closure?
//
// The 2026-08-08 audit of a SQLite symbol graph measured that question at 203k
// tokens (see .claudin/memory/team/code-review-graph-evaluated-rejected.md).
// This asks the same question at FILE level over the import graph, which is the
// only version docs/tech/repo-map/ keeps as plausible, and sizes the answer
// before anything is built to serve it.
//
// Usage: bun scripts/bench/repomap/08-impact-of-answer-size.ts

import { readFileSync } from 'fs'
import { dirname, join, resolve, relative } from 'path'
import { ROOT, gitFiles } from './lib.ts'

const SPEC_RE =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g

const all = gitFiles(ROOT)
const tsFiles = all.filter(p => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p))
const fileSet = new Set(tsFiles)
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']

function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('src/')) base = spec
  else if (spec.startsWith('.')) base = relative(ROOT, resolve(ROOT, dirname(fromFile), spec))
  else return null
  base = base.replace(/\\/g, '/')
  const noExt = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [base, ...EXTS.map(e => `${noExt}${e}`), ...EXTS.map(e => `${noExt}/index${e}`)]
  for (const c of candidates) if (fileSet.has(c)) return c
  return null
}

// forward edges: importer -> imported
const fwd = new Map<string, Set<string>>()
for (const p of tsFiles) {
  let source: string
  try {
    source = readFileSync(join(ROOT, p), 'utf8')
  } catch {
    continue
  }
  const acc = new Set<string>()
  SPEC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SPEC_RE.exec(source))) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue
    const target = resolveSpec(p, spec)
    if (target === null || target === p) continue
    acc.add(target)
  }
  fwd.set(p, acc)
}

// reverse edges: imported -> importers
const rev = new Map<string, Set<string>>()
for (const [from, tos] of fwd) {
  for (const to of tos) {
    if (!rev.has(to)) rev.set(to, new Set())
    rev.get(to)!.add(from)
  }
}

function closure(seed: string): Set<string> {
  const seen = new Set<string>()
  const stack = [seed]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const importer of rev.get(cur) ?? []) {
      if (seen.has(importer)) continue
      seen.add(importer)
      stack.push(importer)
    }
  }
  return seen
}

const tok = (n: number) => Math.ceil(n / 4)
const rows: { file: string; direct: number; transitive: number; chars: number }[] = []
for (const f of tsFiles) {
  const direct = (rev.get(f) ?? new Set()).size
  const cl = closure(f)
  const chars = [...cl].join('\n').length
  rows.push({ file: f, direct, transitive: cl.size, chars })
}

console.log(`nodes ${tsFiles.length}, files with >=1 importer ${rev.size}`)

const pct = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)]!
for (const key of ['direct', 'transitive'] as const) {
  const sorted = rows.map(r => r[key]).sort((a, b) => a - b)
  console.log(
    `\n${key} importers:  p50 ${pct(sorted, 0.5)}  p90 ${pct(sorted, 0.9)}  ` +
      `p99 ${pct(sorted, 0.99)}  max ${pct(sorted, 1)}`,
  )
}

const charsSorted = rows.map(r => r.chars).sort((a, b) => a - b)
console.log(
  `\nanswer size (paths only): p50 ~${tok(pct(charsSorted, 0.5))} tok  ` +
    `p90 ~${tok(pct(charsSorted, 0.9))} tok  p99 ~${tok(pct(charsSorted, 0.99))} tok  ` +
    `max ~${tok(pct(charsSorted, 1))} tok`,
)

const OVER = 2000
const over = rows.filter(r => tok(r.chars) > OVER).length
console.log(
  `files whose transitive answer exceeds ${OVER} tok: ${over} / ${rows.length} ` +
    `(${((over / rows.length) * 100).toFixed(1)}%)`,
)

console.log('\n--- widest blast radius (transitive) ---')
for (const r of rows.sort((a, b) => b.transitive - a.transitive).slice(0, 12)) {
  console.log(
    `  ${String(r.transitive).padStart(5)} files (~${String(tok(r.chars)).padStart(6)} tok)  ` +
      `direct ${String(r.direct).padStart(4)}  ${r.file}`,
  )
}

console.log('\n--- files an agent actually edits (top churn, last 2000 commits) ---')
const { execFileSync } = await import('child_process')
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
const byRow = new Map(rows.map(r => [r.file, r]))
for (const [p, n] of [...churn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  const r = byRow.get(p)
  if (!r) continue
  console.log(
    `  churn ${String(n).padStart(3)}  direct ${String(r.direct).padStart(4)}  ` +
      `transitive ${String(r.transitive).padStart(5)} (~${tok(r.chars)} tok)  ${p}`,
  )
}
