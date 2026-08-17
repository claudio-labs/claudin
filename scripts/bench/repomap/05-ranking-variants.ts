import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ROOT,
  gitFiles,
  buildGraph,
  rankFiles,
  renderMap,
  MIN_IDENT_LEN,
  type FileTags,
} from './lib.ts'
import { KEYWORDS } from './keywords.ts'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'
import {
  scanSymbols,
  maskSourceForLang,
} from '../../../src/tools/shared/codeOutline/scanSymbols.js'
import type { OutlineLang } from '../../../src/tools/shared/codeOutline/types.js'

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g

function extractIdentsKw(masked: string, lang: OutlineLang): Map<string, number> {
  const kw = KEYWORDS[lang]
  const counts = new Map<string, number>()
  IDENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IDENT_RE.exec(masked))) {
    const name = m[0]
    if (name.length < MIN_IDENT_LEN) continue
    if (kw?.has(name)) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

const NULL_MASK_LANGS = new Set<OutlineLang>([
  'markdown',
  'yaml',
  'properties',
  'env',
  'toml',
  'dockerfile',
  'makefile',
])

const all = gitFiles(ROOT)
const eligible = all.filter(p => detectOutlineLangFromPath(p) !== null)

type Raw = {
  path: string
  lang: OutlineLang
  defs: ReturnType<typeof scanSymbols>
  masked: string | null
}
const raws: Raw[] = []
for (const p of eligible) {
  const lang = detectOutlineLangFromPath(p)!
  let source: string
  try {
    source = readFileSync(join(ROOT, p), 'utf8')
  } catch {
    continue
  }
  raws.push({ path: p, lang, defs: scanSymbols(source, lang), masked: maskSourceForLang(source, lang) })
}

type Variant = {
  name: string
  keywords: boolean
  depth0Only: boolean
  dropNullMask: boolean
}
const VARIANTS: Variant[] = [
  { name: 'V1 baseline (no kw filter)', keywords: false, depth0Only: false, dropNullMask: false },
  { name: 'V2 + keyword denylist', keywords: true, depth0Only: false, dropNullMask: false },
  { name: 'V3 + top-level defs only', keywords: true, depth0Only: true, dropNullMask: false },
  { name: 'V4 + drop null-mask langs', keywords: true, depth0Only: true, dropNullMask: true },
]

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

for (const v of VARIANTS) {
  const tags: FileTags[] = []
  for (const r of raws) {
    if (v.dropNullMask && NULL_MASK_LANGS.has(r.lang)) continue
    const defs = v.depth0Only ? r.defs.filter(d => d.depth === 0) : r.defs
    const idents =
      r.masked === null
        ? new Map<string, number>()
        : v.keywords
          ? extractIdentsKw(r.masked, r.lang)
          : extractIdentsKw(r.masked, 'markdown') // no kw set → no filtering
    tags.push({ path: r.path, lang: r.lang, defs, idents, bytes: 0 })
  }

  const { graph, stats } = buildGraph(tags)
  const { ranked, iterations, ms } = rankFiles(graph)
  const tagsMap = new Map(tags.map(t => [t.path, t]))
  const r1024 = renderMap(ranked, tagsMap, 1024)
  const rankOf = new Map(ranked.map((r, i) => [r.path, i + 1]))

  console.log(`\n=== ${v.name} ===`)
  console.log(
    `nodes=${stats.nodeCount} edges=${stats.edgeCount} avgOut=${(stats.edgeCount / stats.nodeCount).toFixed(1)} dangling=${stats.danglingCount} iters=${iterations} prMs=${ms.toFixed(0)}`,
  )
  console.log(
    `defNames=${stats.distinctDefNames} overCap=${stats.fanoutBuckets['>100']} identsResolved=${((stats.identOccurrencesResolved / stats.identOccurrencesTotal) * 100).toFixed(1)}%`,
  )
  console.log(`top1 score=${ranked[0]!.score.toExponential(3)}  top1/top2=${(ranked[0]!.score / ranked[1]!.score).toFixed(2)}x`)
  console.log('top 12:')
  ranked.slice(0, 12).forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${r.path}`))
  console.log('probe ranks:')
  for (const p of PROBES) {
    const r = rankOf.get(p)
    console.log(`  ${(r === undefined ? 'ABSENT' : `#${r}`).padStart(7)}  ${p}`)
  }
  const testsInTop100 = ranked.slice(0, 100).filter(r => /\.test\.tsx?$/.test(r.path)).length
  console.log(`.test.ts in top100: ${testsInTop100}   1024tok map: ${r1024.files.length} files`)
  console.log(`1024tok files: ${r1024.files.slice(0, 8).join(', ')}`)
}
