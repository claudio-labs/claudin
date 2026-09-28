/**
 * The provenance census: how much of each file still matches inherited code.
 * docs/tech/rewrite/README.md is what the numbers are for.
 *
 *   bun run provenance                   totals, then one row per slice
 *   bun run provenance --files [N]       the N files with the most inherited lines (default 40)
 *   bun run provenance --file <path>     the matching line ranges of one file, by origin
 *   bun run provenance --json            every row, for tooling
 *
 * "Inherited" is either origin: a line matching the Claude Code base or the
 * openclaude fork point, verbatim or with its identifiers renamed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { loadReference } from './reference.js'
import { isTestPath, matchFile, type Row, scanTree, sliceOf } from './scan.js'

type Totals = { files: number; lines: number; claudeCode: number; openclaude: number }

function total(rows: Row[]): Totals {
  const out: Totals = { files: 0, lines: 0, claudeCode: 0, openclaude: 0 }
  for (const row of rows) {
    out.files++
    out.lines += row.lines
    out.claudeCode += row.claudeCode
    out.openclaude += row.openclaude
  }
  return out
}

const percent = (part: number, whole: number) => `${whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1)}%`

function describe(label: string, t: Totals): string {
  return (
    `${label.padEnd(24)} ${String(t.files).padStart(5)} files ${String(t.lines).padStart(8)} lines   ` +
    `Claude Code ${String(t.claudeCode).padStart(7)} ${percent(t.claudeCode, t.lines).padStart(6)}   ` +
    `openclaude ${String(t.openclaude).padStart(6)} ${percent(t.openclaude, t.lines).padStart(6)}`
  )
}

/** `[3, 4, 5, 9]` → `4-6, 10` (one-based, the way an editor shows them). */
function ranges(lines: Set<number>): string {
  const sorted = [...lines].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++
    const end = sorted[i]!
    out.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`)
  }
  return out.join(', ')
}

const args = process.argv.slice(2)
const reference = loadReference()

const fileArg = args.indexOf('--file')
if (fileArg !== -1) {
  const file = args[fileArg + 1]
  if (!file) {
    console.error('usage: bun run provenance --file <path>')
    process.exit(1)
  }
  const source = readFileSync(join(REPO_ROOT, file), 'utf8')
  const match = matchFile(file, source, reference)
  const lines = source.split('\n').length
  console.log(`${file}: ${lines} lines`)
  console.log(`  Claude Code ${match.claudeCode.size} (${percent(match.claudeCode.size, lines)}): ${ranges(match.claudeCode) || '-'}`)
  console.log(`  openclaude  ${match.openclaude.size} (${percent(match.openclaude.size, lines)}): ${ranges(match.openclaude) || '-'}`)
  process.exit(0)
}

const rows = scanTree(reference)

if (args.includes('--json')) {
  console.log(JSON.stringify(rows))
  process.exit(0)
}

const filesArg = args.indexOf('--files')
if (filesArg !== -1) {
  const limit = Number(args[filesArg + 1] ?? 40) || 40
  const ranked = rows
    .filter(r => r.claudeCode + r.openclaude > 0)
    .sort((a, b) => b.claudeCode + b.openclaude - (a.claudeCode + a.openclaude))
  for (const row of ranked.slice(0, limit)) {
    const inherited = row.claudeCode + row.openclaude
    console.log(`${String(inherited).padStart(6)} ${percent(inherited, row.lines).padStart(6)}  ${row.file}`)
  }
  console.log(`\n${ranked.length} files match inherited code.`)
  process.exit(0)
}

const production = rows.filter(r => !isTestPath(r.file))
console.log(describe('everything', total(rows)))
console.log(describe('production', total(production)))
console.log(describe('tests and fixtures', total(rows.filter(r => isTestPath(r.file)))))

const bySlice = new Map<string, Row[]>()
for (const row of production) {
  const slice = sliceOf(row.file)
  bySlice.set(slice, [...(bySlice.get(slice) ?? []), row])
}
console.log('\nProduction, by slice (most inherited first):')
const slices = [...bySlice].map(([slice, sliceRows]) => [slice, total(sliceRows)] as const)
slices.sort((a, b) => b[1].claudeCode + b[1].openclaude - (a[1].claudeCode + a[1].openclaude))
for (const [slice, totals] of slices) {
  if (totals.claudeCode + totals.openclaude === 0) continue
  console.log(describe(slice, totals))
}
const clean = slices.filter(([, t]) => t.claudeCode + t.openclaude === 0).map(([slice]) => slice)
if (clean.length > 0) console.log(`\nNothing inherited: ${clean.join(', ')}`)
