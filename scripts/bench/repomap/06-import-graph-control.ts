import { join } from 'path'
import { ROOT, buildImportGraph, gitFiles, moduleFiles, rankFiles, type RepoGraph } from './lib.ts'

// Real module graph: parse import/require/export-from specifiers. The builder
// lives in lib.ts so 10 measures the same graph this control ranks.
const tsFiles = moduleFiles(gitFiles(ROOT))
const { counts: edges, specs, resolved, unresolved: bare } = buildImportGraph(ROOT, tsFiles, {
  skipCommented: false,
})

const nodes = [...tsFiles].sort()
const graph: RepoGraph = { nodes, edges }
let edgeCount = 0
for (const m of edges.values()) edgeCount += m.size

const { ranked, iterations, ms } = rankFiles(graph)
const rankOf = new Map(ranked.map((r, i) => [r.path, i + 1]))

console.log('=== V5 REAL IMPORT GRAPH (ground truth) ===')
console.log(`js/ts files:            ${tsFiles.length}`)
console.log(`specifiers seen:        ${specs}`)
console.log(`resolved to a repo file: ${resolved} (${((resolved / specs) * 100).toFixed(1)}%)`)
console.log(`bare/unresolved:        ${bare}`)
console.log(`nodes=${nodes.length} edges=${edgeCount} avgOut=${(edgeCount / nodes.length).toFixed(1)} dangling=${nodes.length - edges.size}`)
console.log(`density: ${(edgeCount / (nodes.length * (nodes.length - 1))).toExponential(3)}`)
console.log(`iters=${iterations} prMs=${ms.toFixed(0)}`)
console.log(`top1 score=${ranked[0]!.score.toExponential(3)} top1/top2=${(ranked[0]!.score / ranked[1]!.score).toFixed(2)}x`)
console.log('')
console.log('TOP 30:')
ranked.slice(0, 30).forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${r.score.toExponential(2)}  ${r.path}`))
console.log('')
const PROBES = [
  'src/agent/query.ts',
  'src/agent/QueryEngine.ts',
  'src/tools/Tool.ts',
  'src/tools/tools.ts',
  'src/agent/context.ts',
  'src/shared/log.ts',
  'src/agent/repl/REPL.tsx',
  'src/providers/presets/activeProvider.ts',
]
console.log('probe ranks:')
for (const p of PROBES) {
  const r = rankOf.get(p)
  console.log(`  ${(r === undefined ? 'ABSENT' : `#${r}`).padStart(7)}  ${p}`)
}
const testsTop100 = ranked.slice(0, 100).filter(r => /\.test\.tsx?$/.test(r.path)).length
console.log(`.test.ts in top100: ${testsTop100}`)

// Write rank vectors for correlation with the ident graph
import { writeFileSync } from 'fs'
writeFileSync(
  join(import.meta.dir, 'importRanks.json'),
  JSON.stringify(Object.fromEntries(rankOf)),
)
console.log('\n(wrote importRanks.json for correlation)')
