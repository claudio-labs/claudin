// What does a bounded-depth neighbourhood actually COST to answer?
//
// 10 prices its answer as a bare list of repo-relative paths (~34 chars, 8.5
// tokens per file) and that is what docs/tech/repo-map/prior-art.md §2 quotes
// as "p90 ~1k tokens — informative, and not one Grep". But README §8 describes
// the product as "the focus's neighbourhood rendered as budgeted definition
// signatures", which is a different artifact at a different price.
//
// This measures BOTH units over the same graph and the same seeds, so the doc
// can say which product each number prices instead of mixing them:
//
//   path list   — one repo-relative path per member
//   signatures  — renderFileSection() over the member's top-level defs, i.e.
//                 exactly what renderMap() emits, at chars/4
//
// Every module file is a seed; there is no sampling. Definitions are scanned
// once for the whole tree and the per-file section length is memoised, so the
// cost is one extraction pass plus set arithmetic.
//
// Usage: bun scripts/bench/repomap/11-neighbourhood-render-cost.ts

import { execFileSync } from 'child_process'
import {
  ROOT,
  ball,
  buildImportGraph,
  extractPass,
  gitFiles,
  moduleFiles,
  renderFileSection,
} from './lib.ts'

const tsFiles = moduleFiles(gitFiles(ROOT))
const fileSet = new Set(tsFiles)
const { fwd, rev } = buildImportGraph(ROOT, tsFiles, { skipCommented: false })

// ---------------------------------------------------------------------------
// per-file rendered size, using renderMap's own selection rule
// ---------------------------------------------------------------------------

const { tags, timing } = extractPass(ROOT, tsFiles)
const sectionChars = new Map<string, number>()
let defless = 0
for (const t of tags) {
  const defs = t.defs
    .filter(d => d.depth === 0)
    .slice()
    .sort((a, b) => a.startLine - b.startLine)
  if (defs.length === 0) defless++
  sectionChars.set(t.path, renderFileSection(t.path, defs).length)
}
// A file the scanner never reached still costs its path line if it is listed.
const PATH_CHARS = 34
const charsOf = (p: string) => sectionChars.get(p) ?? p.length + 3

const pathTok = (n: number) => Math.ceil((n * PATH_CHARS) / 4)
const sigTok = (members: Set<string>) => {
  let chars = 0
  for (const m of members) chars += charsOf(m)
  return Math.round(chars / 4)
}

const pct = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)]!
const fmt = (n: number) => String(n).padStart(6)

console.log(`nodes ${tsFiles.length}   extraction ${timing.totalMs.toFixed(0)} ms`)
console.log(
  `files with no top-level def: ${defless} (${((defless / tags.length) * 100).toFixed(1)}%)` +
    ' — renderMap skips these, they are priced here at their header line only\n',
)

const secs = [...sectionChars.values()].sort((a, b) => a - b)
console.log('rendered section size per file (chars):')
console.log(
  `  p50 ${fmt(pct(secs, 0.5))}  p90 ${fmt(pct(secs, 0.9))}  p99 ${fmt(pct(secs, 0.99))}  ` +
    `max ${fmt(pct(secs, 1))}  mean ${(secs.reduce((a, b) => a + b, 0) / secs.length).toFixed(0)}`,
)
console.log(
  `  = ${(pct(secs, 0.5) / 4).toFixed(0)} / ${(pct(secs, 0.9) / 4).toFixed(0)} tok per file at p50 / p90` +
    ` (measurements.md §7 assumed ~73 from a 14-file render)\n`,
)

// ---------------------------------------------------------------------------
// the two units, side by side
// ---------------------------------------------------------------------------

const DIRECTIONS: Array<[string, Array<Map<string, Set<string>>>]> = [
  ['forward (deps)', [fwd]],
  ['reverse (importers)', [rev]],
  ['undirected', [fwd, rev]],
]

console.log('neighbourhood answer size — as a path list vs. as definition signatures\n')
console.log(
  '                     files              path list (tok)        signatures (tok)      ratio',
)
console.log(
  '                p50    p90       p50       p90       max       p50       p90       max',
)

for (const [label, adj] of DIRECTIONS) {
  console.log(`${label}:`)
  for (const depth of [1, 2, 3]) {
    const sizes: number[] = []
    const pathToks: number[] = []
    const sigToks: number[] = []
    for (const f of tsFiles) {
      const members = ball(f, depth, adj)
      sizes.push(members.size)
      pathToks.push(pathTok(members.size))
      sigToks.push(sigTok(members))
    }
    sizes.sort((a, b) => a - b)
    pathToks.sort((a, b) => a - b)
    sigToks.sort((a, b) => a - b)
    const p90path = pct(pathToks, 0.9)
    const p90sig = pct(sigToks, 0.9)
    console.log(
      `  depth ${depth}  ${fmt(pct(sizes, 0.5))} ${fmt(pct(sizes, 0.9))}  ` +
        `${fmt(pct(pathToks, 0.5))}  ${fmt(p90path)}  ${fmt(pct(pathToks, 1))}  ` +
        `${fmt(pct(sigToks, 0.5))}  ${fmt(p90sig)}  ${fmt(pct(sigToks, 1))}  ` +
        `${p90path === 0 ? '  n/a' : `${(p90sig / p90path).toFixed(1)}x`}`,
    )
  }
  console.log()
}

// ---------------------------------------------------------------------------
// the files an agent actually edits
// ---------------------------------------------------------------------------

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

console.log('--- the churn leaders, forward and reverse depth 2 ---\n')
console.log('churn   fwd d2  paths   sigs |  rev d2  paths   sigs  file')
for (const [p, n] of [...churn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const f2 = ball(p, 2, [fwd])
  const r2 = ball(p, 2, [rev])
  console.log(
    `${String(n).padStart(5)}  ${String(f2.size).padStart(7)} ${String(pathTok(f2.size)).padStart(6)} ` +
      `${String(sigTok(f2)).padStart(6)} | ${String(r2.size).padStart(7)} ${String(pathTok(r2.size)).padStart(6)} ` +
      `${String(sigTok(r2)).padStart(6)}  ${p}`,
  )
}
