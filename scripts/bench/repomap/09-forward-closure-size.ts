// Is the FORWARD dependency closure degenerate too?
//
// 08 measured the reverse direction and found it constant (p50 = p90 = p99 =
// ~2,462 of 3,359 nodes), which killed `impact_of`. docs/tech/repo-map/ keeps one
// lane alive on the assumption that the forward direction - "what does X depend
// on" - still carries information. This tests that assumption, because if the
// forward closure is also constant then the last surviving lane has no query.
//
// Usage: bun scripts/bench/repomap/09-forward-closure-size.ts

import { ROOT, buildImportGraph, gitFiles, moduleFiles } from './lib.ts'

const tsFiles = moduleFiles(gitFiles(ROOT))
const { fwd } = buildImportGraph(ROOT, tsFiles, { skipCommented: false })

function closure(seed: string): Set<string> {
  const seen = new Set<string>()
  const stack = [seed]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const dep of fwd.get(cur) ?? []) {
      if (seen.has(dep)) continue
      seen.add(dep)
      stack.push(dep)
    }
  }
  return seen
}

const tok = (n: number) => Math.ceil(n / 4)
const rows = tsFiles.map(f => {
  const direct = (fwd.get(f) ?? new Set()).size
  const cl = closure(f)
  return { file: f, direct, transitive: cl.size, chars: [...cl].join('\n').length }
})

const pct = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)]!
console.log(`nodes ${tsFiles.length}`)
for (const key of ['direct', 'transitive'] as const) {
  const s = rows.map(r => r[key]).sort((a, b) => a - b)
  console.log(
    `\nforward ${key} deps:  p10 ${pct(s, 0.1)}  p50 ${pct(s, 0.5)}  p90 ${pct(s, 0.9)}  ` +
      `p99 ${pct(s, 0.99)}  max ${pct(s, 1)}`,
  )
}

// Degeneracy test: how concentrated are the transitive sizes? If one value
// dominates, the query is a constant function like the reverse direction was.
const hist = new Map<number, number>()
for (const r of rows) hist.set(r.transitive, (hist.get(r.transitive) ?? 0) + 1)
const modes = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
console.log('\nmost common transitive sizes (degeneracy check):')
for (const [size, count] of modes) {
  console.log(
    `  ${String(count).padStart(4)} files (${((count / rows.length) * 100).toFixed(1)}%) ` +
      `have a closure of exactly ${size}`,
  )
}
console.log(`  distinct closure sizes: ${hist.size} of ${rows.length} files`)

const charsSorted = rows.map(r => r.chars).sort((a, b) => a - b)
console.log(
  `\nanswer size (paths only): p50 ~${tok(pct(charsSorted, 0.5))} tok  ` +
    `p90 ~${tok(pct(charsSorted, 0.9))} tok  max ~${tok(pct(charsSorted, 1))} tok`,
)
const OVER = 2000
const over = rows.filter(r => tok(r.chars) > OVER).length
console.log(
  `files whose forward answer exceeds ${OVER} tok: ${over} / ${rows.length} ` +
    `(${((over / rows.length) * 100).toFixed(1)}%)`,
)

console.log('\n--- forward closure for the files an agent actually edits ---')
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
    `  churn ${String(n).padStart(3)}  direct ${String(r.direct).padStart(3)}  ` +
      `transitive ${String(r.transitive).padStart(5)} (~${tok(r.chars)} tok)  ${p}`,
  )
}
