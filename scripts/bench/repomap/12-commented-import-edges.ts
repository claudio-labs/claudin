// How many import edges come from a statement that is COMMENTED OUT?
//
// 06 and 10 parse specifiers off the raw source, on purpose: maskSourceForLang
// blanks string contents and an import specifier IS a string, so masking the
// file would destroy the very thing being read (06 carried that comment).
// What neither did is filter matches whose STATEMENT sits inside a comment,
// so `// import { x } from './y'` becomes a real edge.
//
// The mask still answers this, because it preserves length and offsets: the
// keyword at the match index survives masking in real code and is blanked
// inside a comment. lib.ts's buildImportGraph({skipCommented:true}) applies
// exactly that test; this probe measures what it removes and whether the
// removal moves the bounded-depth distribution that prior-art.md §2 rests on.
//
// Usage: bun scripts/bench/repomap/12-commented-import-edges.ts

import { ROOT, ball, buildImportGraph, gitFiles, moduleFiles } from './lib.ts'

const tsFiles = moduleFiles(gitFiles(ROOT))
const raw = buildImportGraph(ROOT, tsFiles, { skipCommented: false })
const filtered = buildImportGraph(ROOT, tsFiles, { skipCommented: true })

const edgeCount = (g: { counts: Map<string, Map<string, number>> }) => {
  let n = 0
  for (const m of g.counts.values()) n += m.size
  return n
}

const rawEdges = edgeCount(raw)
const filteredEdges = edgeCount(filtered)

console.log('=== import statements inside comments ===\n')
console.log(`module files:            ${tsFiles.length}`)
console.log(`unmaskable (no lang/mask): ${filtered.unmaskable}`)
console.log(`matches dropped:         ${filtered.commentedSites.length}`)
console.log(
  `specifiers counted:      ${raw.specs} raw → ${filtered.specs} filtered ` +
    `(−${raw.specs - filtered.specs}, ${(((raw.specs - filtered.specs) / raw.specs) * 100).toFixed(2)}%)`,
)
console.log(
  `resolved:                ${raw.resolved} → ${filtered.resolved} ` +
    `(−${raw.resolved - filtered.resolved}, ${(((raw.resolved - filtered.resolved) / raw.resolved) * 100).toFixed(2)}%)`,
)
console.log(
  `distinct edges:          ${rawEdges} → ${filteredEdges} ` +
    `(−${rawEdges - filteredEdges}, ${(((rawEdges - filteredEdges) / rawEdges) * 100).toFixed(2)}%)`,
)

const byFile = new Map<string, number>()
for (const s of filtered.commentedSites) byFile.set(s.from, (byFile.get(s.from) ?? 0) + 1)
console.log(`files affected:          ${byFile.size}\n`)

if (filtered.commentedSites.length > 0) {
  console.log('worst offenders:')
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}  ${f}`)
  }
  console.log('\nsample of dropped matches:')
  for (const s of filtered.commentedSites.slice(0, 12)) {
    console.log(`  ${s.from}:${s.line}  →  ${s.spec}`)
  }
  console.log()
}

// Edges that exist ONLY in the raw graph: the false ones.
const phantom: Array<[string, string]> = []
for (const [from, targets] of raw.counts) {
  const kept = filtered.counts.get(from)
  for (const to of targets.keys()) if (kept === undefined || !kept.has(to)) phantom.push([from, to])
}
console.log(`edges present only without the filter: ${phantom.length}`)
for (const [from, to] of phantom.slice(0, 12)) console.log(`  ${from}  →  ${to}`)
console.log()

// ---------------------------------------------------------------------------
// does it move the number prior-art.md §2 rests on?
// ---------------------------------------------------------------------------

const pct = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)]!
const DIRECTIONS: Array<[string, (g: typeof raw) => Array<Map<string, Set<string>>>]> = [
  ['forward (deps)', g => [g.fwd]],
  ['reverse (importers)', g => [g.rev]],
  ['undirected', g => [g.fwd, g.rev]],
]

console.log('effect on the bounded-depth distribution (raw → filtered)\n')
console.log('                       p50            p90        distinct sizes')
for (const [label, pick] of DIRECTIONS) {
  console.log(`${label}:`)
  for (const depth of [1, 2]) {
    const row = (g: typeof raw) => {
      const sizes = tsFiles.map(f => ball(f, depth, pick(g)).size).sort((a, b) => a - b)
      return [pct(sizes, 0.5), pct(sizes, 0.9), new Set(sizes).size] as const
    }
    const [aP50, aP90, aD] = row(raw)
    const [bP50, bP90, bD] = row(filtered)
    console.log(
      `  depth ${depth}  ${String(aP50).padStart(6)} → ${String(bP50).padEnd(6)} ` +
        `${String(aP90).padStart(6)} → ${String(bP90).padEnd(6)} ` +
        `${String(aD).padStart(6)} → ${String(bD)}`,
    )
  }
}
