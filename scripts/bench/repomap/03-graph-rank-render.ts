import {
  ROOT,
  gitFiles,
  extractPass,
  buildGraph,
  rankFiles,
  renderMap,
  scoreSum,
  type FileTags,
} from './lib.ts'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'

const scope = process.argv[2] ?? 'all'
const all = gitFiles(ROOT)
const paths = (scope === 'src' ? all.filter(p => p.startsWith('src/')) : all).filter(
  p => detectOutlineLangFromPath(p) !== null,
)

function pipeline(tags: FileTags[]) {
  const { graph, stats } = buildGraph(tags)
  const { ranked, iterations, ms } = rankFiles(graph)
  const tagsMap = new Map(tags.map(t => [t.path, t]))
  const r1024 = renderMap(ranked, tagsMap, 1024)
  const r2048 = renderMap(ranked, tagsMap, 2048)
  return { graph, stats, ranked, iterations, prMs: ms, r1024, r2048 }
}

const { tags } = extractPass(ROOT, paths)
const A = pipeline(tags)
const B = pipeline(tags)

console.log(`=== Q4 SIGNAL — scope=${scope} ===`)
const s = A.stats
console.log(`distinct def names:        ${s.distinctDefNames}`)
console.log('definition fanout distribution:')
for (const [k, v] of Object.entries(s.fanoutBuckets)) {
  console.log(`  ${k.padEnd(8)} ${String(v).padStart(6)}  ${((v / s.distinctDefNames) * 100).toFixed(2)}%`)
}
console.log('')
console.log(`top 20 names above MAX_DEFINITION_FANOUT=100 (dropped entirely):`)
for (const o of s.overCapNames) console.log(`  ${String(o.fanout).padStart(5)}  ${o.name}`)
console.log('')
const tot = s.identOccurrencesTotal
console.log(`ident occurrences total:  ${tot}`)
console.log(`  → became edges:         ${s.identOccurrencesResolved} (${((s.identOccurrencesResolved / tot) * 100).toFixed(1)}%)`)
console.log(`  → dropped, no def:      ${s.identOccurrencesDroppedNoDef} (${((s.identOccurrencesDroppedNoDef / tot) * 100).toFixed(1)}%)`)
console.log(`  → dropped, fanout>100:  ${s.identOccurrencesDroppedFanout} (${((s.identOccurrencesDroppedFanout / tot) * 100).toFixed(1)}%)`)
console.log('')
console.log(`graph build ms:           ${s.buildMs.toFixed(0)}`)
console.log(`nodes:                    ${s.nodeCount}`)
console.log(`edges:                    ${s.edgeCount}`)
console.log(`density (E/(N*(N-1))):    ${(s.edgeCount / (s.nodeCount * (s.nodeCount - 1))).toExponential(3)}`)
console.log(`avg out-degree:           ${(s.edgeCount / s.nodeCount).toFixed(1)}`)
console.log(`dangling (0 out-edges):   ${s.danglingCount} (${((s.danglingCount / s.nodeCount) * 100).toFixed(1)}%)`)

console.log('')
console.log('=== Q5 RANKING ===')
console.log(`iterations to converge:   ${A.iterations}`)
console.log(`pagerank wall ms:         ${A.prMs.toFixed(1)}`)
console.log(`score sum (should be 1):  ${scoreSum(A.ranked).toFixed(12)}`)
console.log('')
console.log('TOP 40:')
A.ranked.slice(0, 40).forEach((r, i) => {
  console.log(`${String(i + 1).padStart(3)}. ${r.score.toExponential(3)}  ${r.path}`)
})
console.log('')
const probes = [
  'src/agent/query.ts',
  'src/agent/QueryEngine.ts',
  'src/tools/Tool.ts',
  'src/tools/tools.ts',
  'src/agent/context.ts',
  'src/shared/log.ts',
]
const rankOf = new Map(A.ranked.map((r, i) => [r.path, i + 1]))
console.log('probe file ranks:')
for (const p of probes) {
  const r = rankOf.get(p)
  console.log(`  ${(r === undefined ? 'ABSENT' : `#${r}`).padStart(7)}  ${p}`)
}

console.log('')
console.log('=== Q6 RENDERED MAP ===')
console.log(`budget 1024 tok → ${A.r1024.files.length} files, ${A.r1024.tokenCount} tok, ${A.r1024.map.length} chars`)
A.r1024.files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
console.log('')
console.log('--- first 40 lines verbatim ---')
console.log(A.r1024.map.split('\n').slice(0, 40).join('\n'))
console.log('--- end ---')
console.log('')
console.log(`budget 2048 tok → ${A.r2048.files.length} files, ${A.r2048.tokenCount} tok`)
A.r2048.files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))

console.log('')
console.log('=== Q7 DETERMINISM ===')
console.log(`render byte-identical across 2 runs: ${A.r1024.map === B.r1024.map}`)
console.log(`rank order identical:                ${A.ranked.map(r => r.path).join('|') === B.ranked.map(r => r.path).join('|')}`)
let ties = 0
let tiesInTop200 = 0
for (let i = 1; i < A.ranked.length; i++) {
  if (A.ranked[i]!.score === A.ranked[i - 1]!.score) {
    ties++
    if (i < 200) tiesInTop200++
  }
}
console.log(`exact float score ties:              ${ties} (of ${A.ranked.length} nodes)`)
console.log(`  ties within top 200:               ${tiesInTop200}`)
const zero = A.ranked.filter(r => r.score === A.ranked[A.ranked.length - 1]!.score).length
console.log(`nodes sharing the minimum score:     ${zero}`)
