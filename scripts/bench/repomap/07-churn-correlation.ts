import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ROOT } from './lib.ts'

const importRanks: Record<string, number> = JSON.parse(
  readFileSync(join(import.meta.dir, 'importRanks.json'), 'utf8'),
)

// churn = number of commits touching the file, last 2000 commits
const out = execFileSync(
  'git',
  ['log', '-2000', '--name-only', '--pretty=format:'],
  { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
)
const churn = new Map<string, number>()
for (const line of out.split('\n')) {
  const p = line.trim()
  if (!p) continue
  churn.set(p, (churn.get(p) ?? 0) + 1)
}

const ranked = Object.entries(importRanks).sort((a, b) => a[1] - b[1])
const byChurn = [...churn.entries()]
  .filter(([p]) => p in importRanks)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

console.log('=== PAGERANK CENTRALITY vs ACTUAL CHURN (import graph, 2000 commits) ===')
console.log(`files with churn data that are graph nodes: ${byChurn.length}`)
console.log('')
for (const N of [10, 25, 50, 100, 200]) {
  const prTop = new Set(ranked.slice(0, N).map(e => e[0]))
  const chTop = new Set(byChurn.slice(0, N).map(e => e[0]))
  let overlap = 0
  for (const p of prTop) if (chTop.has(p)) overlap++
  console.log(`top-${String(N).padStart(3)}: overlap = ${overlap}/${N} (${((overlap / N) * 100).toFixed(0)}%)`)
}

console.log('')
console.log('top 15 by PageRank centrality      | top 15 by churn')
for (let i = 0; i < 15; i++) {
  const a = ranked[i]?.[0] ?? ''
  const b = byChurn[i] ? `${byChurn[i]![0]} (${byChurn[i]![1]})` : ''
  console.log(`${a.slice(0, 34).padEnd(35)}| ${b}`)
}

// Spearman-ish: rank correlation over the intersection
const common = byChurn.filter(([p]) => importRanks[p] !== undefined)
const chRank = new Map(common.map(([p], i) => [p, i + 1]))
let n = 0
let sumD2 = 0
for (const [p, cr] of chRank) {
  const pr = importRanks[p]!
  sumD2 += (pr - cr) ** 2
  n++
}
const rho = 1 - (6 * sumD2) / (n * (n * n - 1))
console.log('')
console.log(`Spearman rho (centrality vs churn), n=${n}: ${rho.toFixed(4)}`)
