import {
  ROOT,
  gitFiles,
  extractPass,
  buildGraph,
  rankFiles,
  COMMON_NAMES,
  MAX_DEFINITION_FANOUT,
  COMMON_NAME_PENALTY,
} from './lib.ts'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'

const all = gitFiles(ROOT)
const paths = all.filter(p => detectOutlineLangFromPath(p) !== null)
const { tags } = extractPass(ROOT, paths)
const { graph, defIndex } = buildGraph(tags)
const { ranked } = rankFiles(graph)

const tagsMap = new Map(tags.map(t => [t.path, t]))

console.log('=== DEF COMPOSITION ===')
let d0 = 0
let dN = 0
const nameDepth = new Map<string, number>()
for (const t of tags) {
  for (const d of t.defs) {
    if (d.depth === 0) d0++
    else dN++
    const cur = nameDepth.get(d.name)
    if (cur === undefined || d.depth < cur) nameDepth.set(d.name, d.depth)
  }
}
console.log(`defs at depth 0:  ${d0}`)
console.log(`defs at depth >0: ${dN}  (${((dN / (d0 + dN)) * 100).toFixed(1)}% — class/object members)`)
let namesOnlyNested = 0
for (const [, dep] of nameDepth) if (dep > 0) namesOnlyNested++
console.log(`def names that ONLY ever appear nested: ${namesOnlyNested} of ${nameDepth.size}`)

console.log('')
console.log('=== WHY IS #1 #1? ===')
const top = ranked[0]!.path
console.log(`#1 = ${top}`)
const topDefs = tagsMap.get(top)!.defs
console.log(`its defs (${topDefs.length}):`)
for (const d of topDefs.slice(0, 30)) {
  const fan = defIndex.get(d.name)!.size
  console.log(`  depth=${d.depth} fanout=${String(fan).padStart(4)}  ${d.kind.padEnd(10)} ${d.name}`)
}
// in-edges
let inW = 0
let inN = 0
const contributors: Array<[string, number]> = []
for (const [src, outs] of graph.edges) {
  const w = outs.get(top)
  if (w !== undefined) {
    inW += w
    inN++
    contributors.push([src, w])
  }
}
contributors.sort((a, b) => b[1] - a[1])
console.log(`in-edges: ${inN} sources, total weight ${inW.toFixed(1)}`)
console.log('top 5 contributors:')
for (const [p, w] of contributors.slice(0, 5)) console.log(`  ${w.toFixed(2)}  ${p}`)

// which identifiers drive it
const drivers = new Map<string, number>()
const totalFiles = tags.length
for (const [src] of graph.edges) {
  const st = tagsMap.get(src)!
  for (const [name, count] of st.idents) {
    const df = defIndex.get(name)
    if (!df || df.size > MAX_DEFINITION_FANOUT || !df.has(top) || src === top) continue
    const raw = Math.log(totalFiles / df.size)
    const w = (COMMON_NAMES.has(name) ? raw * COMMON_NAME_PENALTY : raw) * count
    drivers.set(name, (drivers.get(name) ?? 0) + w)
  }
}
const dr = [...drivers].sort((a, b) => b[1] - a[1])
console.log('identifiers driving those in-edges (top 12):')
for (const [n, w] of dr.slice(0, 12)) {
  console.log(`  ${w.toFixed(1).padStart(9)}  ${n}  (fanout ${defIndex.get(n)!.size}, depth ${nameDepth.get(n)})`)
}

console.log('')
console.log('=== NULL-MASK NODES IN THE TOP 100 ===')
const NULL_MASK = new Set([
  'markdown',
  'yaml',
  'properties',
  'env',
  'toml',
  'dockerfile',
  'makefile',
])
let nm = 0
for (const r of ranked.slice(0, 100)) {
  const t = tagsMap.get(r.path)!
  if (NULL_MASK.has(t.lang)) {
    nm++
    console.log(`  #${ranked.indexOf(r) + 1} ${t.lang.padEnd(10)} ${r.path}`)
  }
}
console.log(`total null-mask files in top 100: ${nm}`)

console.log('')
console.log('=== TEST FILES IN THE TOP 100 ===')
const testCount = ranked.slice(0, 100).filter(r => /\.test\.tsx?$/.test(r.path)).length
console.log(`.test.ts(x) files in top 100: ${testCount}`)
const testShare = tags.filter(t => /\.test\.tsx?$/.test(t.path)).length
console.log(`.test.ts(x) share of corpus:  ${testShare}/${tags.length} = ${((testShare / tags.length) * 100).toFixed(1)}%`)
