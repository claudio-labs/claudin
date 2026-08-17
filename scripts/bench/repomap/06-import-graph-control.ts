import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve, relative } from 'path'
import { ROOT, gitFiles, rankFiles, type RepoGraph } from './lib.ts'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'
import { maskSourceForLang } from '../../../src/tools/shared/codeOutline/scanSymbols.js'

// Real module graph: parse import/require/export-from specifiers.
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
  else return null // bare package
  base = base.replace(/\\/g, '/')
  // strip a .js extension that TS/ESM source writes for a .ts file
  const noExt = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const candidates = [
    base,
    ...EXTS.map(e => `${noExt}${e}`),
    ...EXTS.map(e => `${noExt}/index${e}`),
  ]
  for (const c of candidates) if (fileSet.has(c)) return c
  return null
}

const edges = new Map<string, Map<string, number>>()
let specs = 0
let resolved = 0
let bare = 0
for (const p of tsFiles) {
  const lang = detectOutlineLangFromPath(p)
  let source: string
  try {
    source = readFileSync(join(ROOT, p), 'utf8')
  } catch {
    continue
  }
  const masked = lang ? (maskSourceForLang(source, lang) ?? source) : source
  // masked blanks string contents, so parse specifiers off the RAW source
  const acc = new Map<string, number>()
  SPEC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SPEC_RE.exec(source))) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue
    specs++
    const target = resolveSpec(p, spec)
    if (target === null) {
      bare++
      continue
    }
    if (target === p) continue
    resolved++
    acc.set(target, (acc.get(target) ?? 0) + 1)
  }
  if (acc.size > 0) edges.set(p, acc)
}

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
