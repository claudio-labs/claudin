/**
 * The test floor: a ratchet on how much test code the tree carries, and a
 * roll-call for the invariant suites that are worth more than the ratio.
 *
 * The ratio is NOT a target. 19% test-to-source is not a number anyone should
 * be chasing toward 30%, and a rule that rewards LOC would be trivially gamed
 * by a thousand `expect(true).toBe(true)`. What it is good for is noticing a
 * DROP — a refactor that deletes a suite along with the code it covered, or a
 * merge that loses a file. So the floor only ever moves up, the same way
 * typecheck-baseline.json works, and it is stored with a tolerance so ordinary
 * churn does not force a rewrite on every commit.
 *
 * The roll-call is the part that carries the weight. The three suites named
 * below assert properties that no coverage percentage would notice:
 *
 *   - requestDeterminism.invariant  — the same conversation must serialize to
 *     the same request bytes, or the prompt cache silently stops hitting.
 *   - stableStubState.stub-byte-stability — a compaction stub must be
 *     byte-identical across runs for the same reason.
 *   - phase12Report — the per-filter reduction report for the bash filter.
 *
 * …plus the four build-system invariant suites in `scripts/`, which
 * .claudin/rules/testing.md already names as must-run when touching
 * scripts/build.ts. They live outside `src/`, so an earlier version of this
 * script could not see them at all: deleting every one of them left the floor
 * green. Both trees are walked now.
 *
 * Deleting one of those is a decision, not a cleanup, so it has to be made
 * here rather than by dropping a file.
 *
 *   bun run test:floor           check the tree against test-floor.json
 *   bun run test:floor:update    rewrite that file from the current tree
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const CWD = process.cwd()
const FLOOR_PATH = join(CWD, 'test-floor.json')

/** Ordinary churn should not force a floor rewrite; a real loss should. */
const TOLERANCE_PCT = 0.5

type Floor = {
  '//': string
  ratioPct: number
  testLoc: number
  sourceLoc: number
  testFiles: number
  requiredSuites: string[]
  capturedAt: string
}

const REQUIRED_SUITES = [
  'src/services/compact/requestDeterminism.invariant.test.ts',
  'src/services/compact/stableStubState.stub-byte-stability.test.ts',
  'src/outputFilter/Bash/phase12Report.test.ts',
  'scripts/feature-flags-source-guard.test.ts',
  'scripts/measure-tool-schemas.test.ts',
  'scripts/no-telemetry-growthbook-stub.test.ts',
  'scripts/pr-intent-scan.test.ts',
]

/** Trees the ratio is measured over. `scripts/` carries the build invariants. */
const ROOTS = ['src', 'scripts']

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function countLines(path: string): number {
  // Cheap and deterministic: no parsing, no blank/comment heuristics. The
  // point is the delta between two runs, and any consistent rule gives that.
  return readFileSync(path, 'utf8').split('\n').length
}

export function measure(): Omit<Floor, '//' | 'capturedAt' | 'requiredSuites'> {
  let testLoc = 0
  let sourceLoc = 0
  let testFiles = 0
  for (const root of ROOTS) {
    for (const file of walk(join(CWD, root))) {
      const rel = relative(CWD, file)
      const lines = countLines(file)
      if (isTestFile(rel)) {
        testLoc += lines
        testFiles++
      } else {
        sourceLoc += lines
      }
    }
  }
  return {
    ratioPct: Number(((100 * testLoc) / sourceLoc).toFixed(2)),
    testLoc,
    sourceLoc,
    testFiles,
  }
}

function missingSuites(): string[] {
  return REQUIRED_SUITES.filter(suite => {
    try {
      return !statSync(join(CWD, suite)).isFile()
    } catch {
      return true
    }
  })
}

function readFloor(): Floor | null {
  try {
    return JSON.parse(readFileSync(FLOOR_PATH, 'utf8')) as Floor
  } catch {
    return null
  }
}

function write(current: ReturnType<typeof measure>): void {
  const floor: Floor = {
    '//': 'Written by `bun run test:floor:update`. The ratio is a ratchet against loss, not a target — see scripts/test-floor.ts.',
    ...current,
    requiredSuites: REQUIRED_SUITES,
    capturedAt: new Date().toISOString().slice(0, 10),
  }
  writeFileSync(FLOOR_PATH, `${JSON.stringify(floor, null, 2)}\n`)
  console.log(
    `Wrote test-floor.json — ${floor.ratioPct}% (${floor.testLoc.toLocaleString()} test / ${floor.sourceLoc.toLocaleString()} source LOC, ${floor.testFiles} test files).`,
  )
}

const current = measure()

if (process.argv.includes('--update')) {
  write(current)
  process.exit(0)
}

const floor = readFloor()
const gone = missingSuites()
let failed = false

if (gone.length > 0) {
  failed = true
  console.error('✗ required invariant suites are missing:')
  for (const suite of gone) console.error(`    ${suite}`)
  console.error(
    '\n  These assert properties no coverage number would catch. If one is\n' +
      '  genuinely obsolete, remove it from REQUIRED_SUITES in scripts/test-floor.ts\n' +
      '  in the same commit, so the deletion is on the record.',
  )
}

if (!floor) {
  console.error('✗ no test-floor.json — record one with: bun run test:floor:update')
  process.exit(1)
}

const drop = floor.ratioPct - current.ratioPct
if (drop > TOLERANCE_PCT) {
  failed = true
  console.error(
    `✗ test ratio fell ${drop.toFixed(2)}pp below the floor: ` +
      `${current.ratioPct}% now vs ${floor.ratioPct}% recorded ${floor.capturedAt}.`,
  )
  console.error(
    `    test LOC   ${floor.testLoc.toLocaleString()} → ${current.testLoc.toLocaleString()}\n` +
      `    source LOC ${floor.sourceLoc.toLocaleString()} → ${current.sourceLoc.toLocaleString()}\n` +
      `    test files ${floor.testFiles} → ${current.testFiles}\n\n` +
      '  A drop is usually a suite deleted with the code it covered. If the loss\n' +
      '  is deliberate, re-record with: bun run test:floor:update',
  )
}

if (failed) process.exit(1)

const gain = current.ratioPct - floor.ratioPct
console.log(
  `✓ test floor holds: ${current.ratioPct}% (floor ${floor.ratioPct}%` +
    `${gain > TOLERANCE_PCT ? `, ${gain.toFixed(2)}pp ahead — refresh with test:floor:update` : ''}), ` +
    `${REQUIRED_SUITES.length}/${REQUIRED_SUITES.length} invariant suites present.`,
)
