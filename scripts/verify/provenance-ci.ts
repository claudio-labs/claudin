/**
 * The provenance ratchet: fail a change for the inherited code it ADDS.
 *
 * Inherited means a line matching the Claude Code base or the openclaude fork
 * point, verbatim or with its identifiers renamed (scripts/verify/provenance/).
 * The clean-base rewrite takes that number to zero one module at a time; this
 * gate is what keeps it from climbing back, whether through a port from
 * openclaude, a snippet pasted from the old implementation into the new one, or
 * a refactor that only renamed things. docs/tech/rewrite/README.md has the
 * process it belongs to.
 *
 *   bun run provenance:ci        check the tree against provenance-baseline.json
 *   bun run provenance:baseline  rewrite that file from the current tree
 *
 * The refresh refuses to raise the total. Moving a file keeps the total and
 * goes through; genuinely new inherited code does not, unless it is forced with
 * --allow-growth, which exists for rebuilding the reference and nothing else.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot.js'
import { loadReference } from './provenance/reference.js'
import { type Baseline, compare, serializeBaseline, toAllowances, totals } from './provenance/ratchet.js'
import { scanTree } from './provenance/scan.js'

const BASELINE_PATH = join(REPO_ROOT, 'provenance-baseline.json')

/** Enough of the grown files to act on; the count in the footer is exact. */
const MAX_SHOWN = 40

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Partial<Baseline>
    if (typeof parsed.files !== 'object' || parsed.files === null) return null
    return {
      capturedAt: parsed.capturedAt ?? 'unknown',
      capturedFrom: parsed.capturedFrom ?? 'unknown',
      files: parsed.files,
    }
  } catch {
    return null
  }
}

function headSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

const rows = scanTree(loadReference())
if (rows.length === 0) {
  console.error('ERROR: the scan found no files at all. That is a broken checkout or cwd, not a clean tree.')
  process.exit(1)
}

const baseline = readBaseline()
const files = toAllowances(rows)
const [ccNow, ocNow] = totals(files)

if (process.argv.includes('--update')) {
  if (baseline) {
    const [ccBefore, ocBefore] = totals(baseline.files)
    const growth = ccNow + ocNow - (ccBefore + ocBefore)
    if (growth > 0 && !process.argv.includes('--allow-growth')) {
      console.error(
        `ERROR: the tree has ${growth} more inherited lines than provenance-baseline.json ` +
          `(${ccNow + ocNow} against ${ccBefore + ocBefore}), and a refresh only ever lowers it.\n` +
          'Find them with: bun run provenance:ci',
      )
      process.exit(1)
    }
  }
  writeFileSync(BASELINE_PATH, serializeBaseline({ capturedAt: new Date().toISOString().slice(0, 10), capturedFrom: headSha(), files }))
  console.log(`Wrote provenance-baseline.json: ${ccNow} Claude Code + ${ocNow} openclaude lines in ${Object.keys(files).length} files.`)
  process.exit(0)
}

if (!baseline) {
  console.error('ERROR: provenance-baseline.json is missing or unreadable.\nRecord it with: bun run provenance:baseline')
  process.exit(1)
}

const result = compare(rows, baseline)
const summary = `${ccNow} Claude Code + ${ocNow} openclaude lines, baseline ${result.baseline[0]} + ${result.baseline[1]} (${baseline.capturedAt})`

if (result.grown.length === 0) {
  console.log(`✓ no new inherited code. (${summary})`)
  if (result.shed > 0) {
    console.log(`  ${result.shed} inherited lines gone since the baseline. Tighten it: bun run provenance:baseline`)
  }
  process.exit(0)
}

console.error(`✗ ${result.grown.length} file(s) match more inherited code than provenance-baseline.json allows\n`)
for (const { file, now, allowed } of result.grown.slice(0, MAX_SHOWN)) {
  console.error(`  ${file}  Claude Code ${allowed[0]} → ${now[0]}, openclaude ${allowed[1]} → ${now[1]}`)
}
if (result.grown.length > MAX_SHOWN) console.error(`  … and ${result.grown.length - MAX_SHOWN} more`)
console.error(
  '\nSee which lines match with: bun run provenance --file <path>\n' +
    'Rewrite them from the spec instead of carrying them over. If the file only moved,\n' +
    'refresh the baseline in the same change: bun run provenance:baseline',
)
process.exit(1)
