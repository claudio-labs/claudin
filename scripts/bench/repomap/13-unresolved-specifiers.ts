// What is the 21% of import specifiers that never resolves, and is the 22.1%
// of files with an EMPTY reverse-depth-2 neighbourhood real or an artifact?
//
// measurements.md §5 reports 79.0% resolution without saying what the other
// 21% is, and 10 reports `reverse depth 2 | mode 0 shared by 22.1%` — one file
// in five with no importer within two hops, in the direction a "who uses this"
// query would take. The whole surviving lane is read off this graph, so both
// numbers need a cause before anything is built on them.
//
// Part 1 buckets every unresolved specifier by why it failed. Part 2 splits the
// empty-reverse files into the ones that are legitimately leaves (tests,
// scripts, entrypoints, type-only decls) and the residue that would be a
// resolver bug.
//
// Usage: bun scripts/bench/repomap/13-unresolved-specifiers.ts

import {
  ROOT,
  ball,
  buildImportGraph,
  classifyUnresolved,
  gitFiles,
  moduleFiles,
  type UnresolvedReason,
} from './lib.ts'

const tsFiles = moduleFiles(gitFiles(ROOT))
const g = buildImportGraph(ROOT, tsFiles, { skipCommented: false })

// ---------------------------------------------------------------------------
// Part 1 — why specifiers fail to resolve
// ---------------------------------------------------------------------------

const byReason = new Map<UnresolvedReason, number>()
const bareNames = new Map<string, number>()
const misses: Record<'relative-miss' | 'src-miss', Array<{ from: string; spec: string; line: number }>> =
  { 'relative-miss': [], 'src-miss': [] }

for (const site of g.unresolvedSites) {
  const reason = classifyUnresolved(site.spec)
  byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  if (reason === 'bare') {
    const pkg = site.spec.startsWith('@')
      ? site.spec.split('/').slice(0, 2).join('/')
      : site.spec.split('/')[0]!
    bareNames.set(pkg, (bareNames.get(pkg) ?? 0) + 1)
  } else if (reason === 'relative-miss' || reason === 'src-miss') {
    misses[reason].push(site)
  }
}

console.log('=== part 1: the unresolved specifiers ===\n')
console.log(
  `specifiers ${g.specs}  resolved ${g.resolved} (${((g.resolved / g.specs) * 100).toFixed(1)}%)  ` +
    `unresolved ${g.unresolved} (${((g.unresolved / g.specs) * 100).toFixed(1)}%)\n`,
)
for (const reason of ['bare', 'builtin', 'relative-miss', 'src-miss'] as const) {
  const n = byReason.get(reason) ?? 0
  console.log(
    `  ${reason.padEnd(14)} ${String(n).padStart(6)}  ` +
      `${((n / g.unresolved) * 100).toFixed(1)}% of unresolved`,
  )
}

console.log('\ntop bare packages:')
for (const [pkg, n] of [...bareNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(5)}  ${pkg}`)
}

// The two that would be a real hole: a repo-shaped specifier pointing at
// nothing tracked. The fork imports .d.ts-only modules on purpose, so this is
// where that shows up.
for (const reason of ['relative-miss', 'src-miss'] as const) {
  const list = misses[reason]
  console.log(`\n${reason}: ${list.length}`)
  const byTail = new Map<string, number>()
  for (const s of list) byTail.set(s.spec, (byTail.get(s.spec) ?? 0) + 1)
  for (const [spec, n] of [...byTail.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const sample = list.find(s => s.spec === spec)!
    console.log(`  ${String(n).padStart(4)}  ${spec}   (e.g. ${sample.from}:${sample.line})`)
  }
}

// ---------------------------------------------------------------------------
// Part 2 — the files nobody imports within two hops
// ---------------------------------------------------------------------------

const empty = tsFiles.filter(f => ball(f, 2, [g.rev]).size === 0)

const isTest = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
const isScript = (p: string) => p.startsWith('scripts/')
const isDecl = (p: string) => p.endsWith('.d.ts')
const isEntry = (p: string) => p.startsWith('src/platform/entrypoints/') || p.startsWith('bin/')
const isVendor = (p: string) =>
  p.startsWith('src/vendor/') || p.startsWith('src/stubs/') || p.startsWith('src/native-ts/')

const buckets: Array<[string, (p: string) => boolean]> = [
  ['test', isTest],
  ['scripts/', isScript],
  ['.d.ts', isDecl],
  ['entrypoint', isEntry],
  ['vendor/stub', isVendor],
]

console.log('\n\n=== part 2: files with an empty reverse depth-2 neighbourhood ===\n')
console.log(
  `${empty.length} of ${tsFiles.length} (${((empty.length / tsFiles.length) * 100).toFixed(1)}%)\n`,
)

const claimed = new Set<string>()
for (const [label, pred] of buckets) {
  const hit = empty.filter(p => !claimed.has(p) && pred(p))
  for (const p of hit) claimed.add(p)
  console.log(
    `  ${label.padEnd(12)} ${String(hit.length).padStart(5)}  ` +
      `${((hit.length / empty.length) * 100).toFixed(1)}%`,
  )
}
const residue = empty.filter(p => !claimed.has(p))
console.log(
  `  ${'residue'.padEnd(12)} ${String(residue.length).padStart(5)}  ` +
    `${((residue.length / empty.length) * 100).toFixed(1)}%  ← would be a resolver hole`,
)

const inSrc = residue.filter(p => p.startsWith('src/'))
console.log(`\nresidue under src/: ${inSrc.length}`)
for (const p of inSrc.slice(0, 25)) console.log(`  ${p}`)
if (inSrc.length > 25) console.log(`  … ${inSrc.length - 25} more`)

// Is any residue file the target of a specifier that failed to resolve?
// Match on the last path segment, which is what a miss would have written.
const tailOf = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '').split('/').pop()!
const missTails = new Set<string>()
for (const reason of ['relative-miss', 'src-miss'] as const) {
  for (const s of misses[reason]) missTails.add(tailOf(s.spec))
}
const shadowed = residue.filter(p => missTails.has(tailOf(p)))
console.log(
  `\nresidue files whose basename appears in an unresolved specifier: ${shadowed.length}`,
)
for (const p of shadowed.slice(0, 15)) console.log(`  ${p}`)
