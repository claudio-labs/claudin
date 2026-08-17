import { execFileSync } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT } from '../../repoRoot'
import { detectOutlineLangFromPath } from '../../../src/tools/shared/codeOutline/detectLang.js'
import {
  scanSymbols,
  maskSourceForLang,
} from '../../../src/tools/shared/codeOutline/scanSymbols.js'
import type {
  OutlineLang,
  SymbolEntry,
} from '../../../src/tools/shared/codeOutline/types.js'

export const ROOT = REPO_ROOT

export const ALL_LANGS: OutlineLang[] = [
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'csharp',
  'rust',
  'markdown',
  'c',
  'php',
  'swift',
  'scala',
  'bash',
  'dart',
  'groovy',
  'ruby',
  'lua',
  'elixir',
  'powershell',
  'sql',
  'css',
  'html',
  'yaml',
  'xml',
  'properties',
  'env',
  'toml',
  'dockerfile',
  'makefile',
  'graphql',
  'terraform',
]

export function gitFiles(root: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
  )
  return out
    .toString('utf8')
    .split('\0')
    .filter(s => s.length > 0)
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g
export const MIN_IDENT_LEN = 3

export function extractIdents(masked: string): Map<string, number> {
  const counts = new Map<string, number>()
  IDENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IDENT_RE.exec(masked))) {
    const name = m[0]
    if (name.length < MIN_IDENT_LEN) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export type FileTags = {
  path: string
  lang: OutlineLang
  defs: SymbolEntry[]
  idents: Map<string, number>
  bytes: number
}

export type PassTiming = {
  readMs: number
  scanMs: number
  identMs: number
  totalMs: number
  rssStart: number
  rssPeak: number
}

export function extractPass(
  root: string,
  paths: string[],
): { tags: FileTags[]; timing: PassTiming } {
  const tags: FileTags[] = []
  let readMs = 0
  let scanMs = 0
  let identMs = 0
  const rssStart = process.memoryUsage().rss
  let rssPeak = rssStart
  const t0 = performance.now()

  let i = 0
  for (const p of paths) {
    const lang = detectOutlineLangFromPath(p)
    if (lang === null) continue

    const tr0 = performance.now()
    let source: string
    let bytes: number
    try {
      source = readFileSync(join(root, p), 'utf8')
      bytes = Buffer.byteLength(source)
    } catch {
      continue
    }
    readMs += performance.now() - tr0

    const ts0 = performance.now()
    const masked = maskSourceForLang(source, lang)
    const defs = scanSymbols(source, lang)
    scanMs += performance.now() - ts0

    const ti0 = performance.now()
    const idents = masked === null ? new Map<string, number>() : extractIdents(masked)
    identMs += performance.now() - ti0

    tags.push({ path: p, lang, defs, idents, bytes })

    if (++i % 200 === 0) {
      const rss = process.memoryUsage().rss
      if (rss > rssPeak) rssPeak = rss
    }
  }
  const totalMs = performance.now() - t0
  const rssEnd = process.memoryUsage().rss
  if (rssEnd > rssPeak) rssPeak = rssEnd

  return { tags, timing: { readMs, scanMs, identMs, totalMs, rssStart, rssPeak } }
}

// --------------------------------------------------------------------------
// graph
// --------------------------------------------------------------------------

export const COMMON_NAMES = new Set(
  ('map get set value key data result error name type id index item items list ' +
    'options config args params props state event callback handler fn func self ' +
    'this ctx context req res next err msg obj arr str num val init start stop ' +
    'run main test setup teardown constructor toString valueOf length size count ' +
    'push pop shift filter reduce forEach find log warn info debug trace').split(' '),
)
export const MAX_DEFINITION_FANOUT = 100
export const COMMON_NAME_PENALTY = 0.1

export type RepoGraph = {
  nodes: string[]
  edges: Map<string, Map<string, number>>
}

export type GraphStats = {
  distinctDefNames: number
  fanoutBuckets: Record<string, number>
  overCapNames: Array<{ name: string; fanout: number }>
  identOccurrencesTotal: number
  identOccurrencesResolved: number
  identOccurrencesDroppedNoDef: number
  identOccurrencesDroppedFanout: number
  nodeCount: number
  edgeCount: number
  danglingCount: number
  buildMs: number
}

export function buildGraph(
  allTags: FileTags[],
): { graph: RepoGraph; stats: GraphStats; defIndex: Map<string, Set<string>> } {
  const t0 = performance.now()
  const defIndex = new Map<string, Set<string>>()
  for (const ft of allTags) {
    for (const d of ft.defs) {
      let files = defIndex.get(d.name)
      if (!files) {
        files = new Set()
        defIndex.set(d.name, files)
      }
      files.add(ft.path)
    }
  }

  const totalFiles = allTags.length
  const idfCache = new Map<string, number>()
  function idf(name: string): number {
    const cached = idfCache.get(name)
    if (cached !== undefined) return cached
    const defFiles = defIndex.get(name)
    const docFreq = defFiles ? defFiles.size : 1
    const raw = Math.log(totalFiles / docFreq)
    const v = COMMON_NAMES.has(name) ? raw * COMMON_NAME_PENALTY : raw
    idfCache.set(name, v)
    return v
  }

  const nodes = allTags.map(t => t.path).sort()
  const edges = new Map<string, Map<string, number>>()

  let occTotal = 0
  let occResolved = 0
  let occNoDef = 0
  let occFanout = 0

  for (const ft of allTags) {
    const acc = new Map<string, number>()
    for (const [name, count] of ft.idents) {
      occTotal += count
      const defFiles = defIndex.get(name)
      if (!defFiles) {
        occNoDef += count
        continue
      }
      if (defFiles.size > MAX_DEFINITION_FANOUT) {
        occFanout += count
        continue
      }
      const w = idf(name) * count
      if (!Number.isFinite(w) || w <= 0) {
        occNoDef += count
        continue
      }
      let contributed = false
      for (const B of defFiles) {
        if (B === ft.path) continue
        acc.set(B, (acc.get(B) ?? 0) + w)
        contributed = true
      }
      if (contributed) occResolved += count
      else occNoDef += count
    }
    if (acc.size > 0) edges.set(ft.path, acc)
  }

  let edgeCount = 0
  for (const m of edges.values()) edgeCount += m.size
  const danglingCount = nodes.length - edges.size

  const buckets = { '1': 0, '2-5': 0, '6-20': 0, '21-100': 0, '>100': 0 }
  const over: Array<{ name: string; fanout: number }> = []
  for (const [name, files] of defIndex) {
    const n = files.size
    if (n === 1) buckets['1']++
    else if (n <= 5) buckets['2-5']++
    else if (n <= 20) buckets['6-20']++
    else if (n <= 100) buckets['21-100']++
    else {
      buckets['>100']++
      over.push({ name, fanout: n })
    }
  }
  over.sort((a, b) => b.fanout - a.fanout || a.name.localeCompare(b.name))

  return {
    graph: { nodes, edges },
    defIndex,
    stats: {
      distinctDefNames: defIndex.size,
      fanoutBuckets: buckets,
      overCapNames: over.slice(0, 20),
      identOccurrencesTotal: occTotal,
      identOccurrencesResolved: occResolved,
      identOccurrencesDroppedNoDef: occNoDef,
      identOccurrencesDroppedFanout: occFanout,
      nodeCount: nodes.length,
      edgeCount,
      danglingCount,
      buildMs: performance.now() - t0,
    },
  }
}

// --------------------------------------------------------------------------
// pagerank
// --------------------------------------------------------------------------

export const ALPHA = 0.85
export const TOLERANCE = 1e-6
export const MAX_ITER = 100

export type RankedFile = { path: string; score: number }

export function rankFiles(
  graph: RepoGraph,
  focus: string[] = [],
): { ranked: RankedFile[]; iterations: number; ms: number } {
  const t0 = performance.now()
  const n = graph.nodes.length
  if (n === 0) return { ranked: [], iterations: 0, ms: 0 }

  const idx = new Map<string, number>()
  for (let i = 0; i < n; i++) idx.set(graph.nodes[i]!, i)

  // CSR by source, weights normalized per source
  const offsets = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const out = graph.edges.get(graph.nodes[i]!)
    offsets[i + 1] = offsets[i]! + (out ? out.size : 0)
  }
  const nnz = offsets[n]!
  const targets = new Int32Array(nnz)
  const weights = new Float64Array(nnz)
  const isDangling = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const out = graph.edges.get(graph.nodes[i]!)
    let k = offsets[i]!
    let sum = 0
    if (out) for (const w of out.values()) sum += w
    if (!out || sum <= 0) {
      isDangling[i] = 1
      continue
    }
    for (const [t, w] of out) {
      targets[k] = idx.get(t)!
      weights[k] = w / sum
      k++
    }
  }

  const p = new Float64Array(n)
  if (focus.length > 0) {
    for (const f of focus) {
      const i = idx.get(f)
      if (i !== undefined) p[i] = 1 / focus.length
    }
    let s = 0
    for (let i = 0; i < n; i++) s += p[i]!
    if (s === 0) p.fill(1 / n)
  } else {
    p.fill(1 / n)
  }

  let pr = new Float64Array(n)
  pr.fill(1 / n)
  let next = new Float64Array(n)
  let iterations = 0

  for (let it = 0; it < MAX_ITER; it++) {
    iterations = it + 1
    next.fill(0)
    let leaked = 0
    for (let v = 0; v < n; v++) {
      if (isDangling[v]) {
        leaked += pr[v]!
        continue
      }
      const pv = pr[v]!
      if (pv === 0) continue
      const end = offsets[v + 1]!
      for (let k = offsets[v]!; k < end; k++) {
        next[targets[k]!] = next[targets[k]!]! + ALPHA * pv * weights[k]!
      }
    }
    const teleport = 1 - ALPHA + ALPHA * leaked
    let diff = 0
    for (let u = 0; u < n; u++) {
      next[u] = next[u]! + teleport * p[u]!
      diff += Math.abs(next[u]! - pr[u]!)
    }
    const tmp = pr
    pr = next
    next = tmp
    if (diff < TOLERANCE) break
  }

  const ranked: RankedFile[] = []
  for (let i = 0; i < n; i++) ranked.push({ path: graph.nodes[i]!, score: pr[i]! })
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { ranked, iterations, ms: performance.now() - t0 }
}

export function scoreSum(ranked: RankedFile[]): number {
  let s = 0
  for (const r of ranked) s += r.score
  return s
}

// --------------------------------------------------------------------------
// render
// --------------------------------------------------------------------------

export function renderFileSection(path: string, defs: SymbolEntry[]): string {
  const lines: string[] = [`${path}:`]
  let lastLine = 0
  for (const d of defs) {
    if (d.startLine > lastLine + 1) lines.push('⋮')
    lines.push(`  ${d.signature}`)
    lastLine = d.startLine
  }
  lines.push('⋮')
  return lines.join('\n')
}

export function renderMap(
  ranked: RankedFile[],
  tagsMap: Map<string, FileTags>,
  maxTokens: number,
): { map: string; tokenCount: number; files: string[] } {
  const sections: string[] = []
  const files: string[] = []
  let tokens = 0
  for (const { path } of ranked) {
    const ft = tagsMap.get(path)
    if (!ft) continue
    const defs = ft.defs
      .filter(d => d.depth === 0)
      .slice()
      .sort((a, b) => a.startLine - b.startLine)
    if (defs.length === 0) continue
    const section = renderFileSection(path, defs)
    const sectionTokens = Math.round(section.length / 4)
    if (tokens + sectionTokens > maxTokens) continue
    sections.push(section)
    files.push(path)
    tokens += sectionTokens
  }
  return { map: sections.join('\n'), tokenCount: tokens, files }
}

export function fileBytes(root: string, p: string): number {
  try {
    return statSync(join(root, p)).size
  } catch {
    return 0
  }
}
