// Does BOUNDED-DEPTH neighbourhood dodge the closure degeneracy?
//
// 08 and 09 measured full transitive closures and found both directions
// constant, and docs/tech/repo-map/ concluded there is "nothing in between" the
// whole core and the direct edges. That conclusion skipped a case: three sibling
// implementations do not compute closures at all, they compute a bounded-depth
// neighbourhood.
//
//   code-graph-mcp   get_call_graph, default depth 3, row limit 200
//                    (src/graph/query.rs:11,16)
//   code-review-graph MAX_IMPACT_DEPTH=2, MAX_IMPACT_NODES=500, ranked
//                    (code_review_graph/constants.py:43-44)
//
// Depth-bounding is a real escape hatch from a degenerate closure, so it has to
// be measured rather than argued. This reports the neighbourhood size at k=1,2,3
// in both directions and undirected, and asks whether the answer still collapses
// to one number.
//
// Usage: bun scripts/bench/repomap/10-bounded-depth-neighbourhood.ts

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

const fwd = new Map<string, Set<string>>()
const rev = new Map<string, Set<string>>()
for (const p of tsFiles) {
  let source: string
  try {
    source = readFileSync(join(ROOT, p), 'utf8')
  } catch {
    continue
  }
  SPEC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SPEC_RE.exec(source))) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue
    const target = resolveSpec(p, spec)
    if (target === null || target === p) continue
    if (!fwd.has(p)) fwd.set(p, new Set())
    fwd.get(p)!.add(target)
    if (!rev.has(target)) rev.set(target, new Set())
    rev.get(target)!.add(p)
  }
}

/** Nodes within exactly `depth` hops of `seed`, following `adj`. Excludes seed. */
function ball(seed: string, depth: number, adj: Array<Map<string, Set<string>>>): number {
  const seen = new Set<string>([seed])
  let frontier = [seed]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const a of adj) {
        for (const n of a.get(cur) ?? []) {
          if (seen.has(n)) continue
          seen.add(n)
          next.push(n)
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return seen.size - 1
}

const tok = (n: number) => Math.ceil((n * 34) / 4) // ~34 chars per repo-relative path
const pct = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)]!

const DIRECTIONS: Array<[string, Array<Map<string, Set<string>>>]> = [
  ['forward (deps)', [fwd]],
  ['reverse (importers)', [rev]],
  ['undirected', [fwd, rev]],
]

console.log(`nodes ${tsFiles.length}\n`)
console.log('neighbourhood size by depth — p50 / p90 / max, and the degeneracy check')
console.log('(mode = the single most common size; share = how many files return it)\n')

for (const [label, adj] of DIRECTIONS) {
  console.log(`${label}:`)
  for (const depth of [1, 2, 3]) {
    const sizes = tsFiles.map(f => ball(f, depth, adj))
    const sorted = [...sizes].sort((a, b) => a - b)
    const hist = new Map<number, number>()
    for (const s of sizes) hist.set(s, (hist.get(s) ?? 0) + 1)
    const [modeSize, modeCount] = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]!
    const distinct = hist.size
    console.log(
      `  depth ${depth}:  p50 ${String(pct(sorted, 0.5)).padStart(5)}  ` +
        `p90 ${String(pct(sorted, 0.9)).padStart(5)}  ` +
        `max ${String(pct(sorted, 1)).padStart(5)}  ` +
        `| mode ${String(modeSize).padStart(5)} shared by ${((modeCount / sizes.length) * 100).toFixed(1).padStart(5)}% ` +
        `| ${String(distinct).padStart(4)} distinct sizes ` +
        `| p90 answer ~${tok(pct(sorted, 0.9))} tok`,
    )
  }
  console.log()
}

// The sibling implementations' actual defaults, applied to the files an agent edits.
console.log('--- the two shipped configurations, on claudin churn leaders ---')
console.log("(crg: undirected depth 2, cap 500 | cg-mcp: reverse depth 3, cap 200)\n")
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
console.log(
  'churn  crg d2(undir)  capped  cg-mcp d3(rev)  capped  file',
)
for (const [p, n] of [...churn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const crg = ball(p, 2, [fwd, rev])
  const mcp = ball(p, 3, [rev])
  console.log(
    `${String(n).padStart(5)}  ${String(crg).padStart(12)}  ` +
      `${(crg > 500 ? 'YES' : 'no').padStart(6)}  ${String(mcp).padStart(14)}  ` +
      `${(mcp > 200 ? 'YES' : 'no').padStart(6)}  ${p}`,
  )
}
