/**
 * The coverage gate a lever or a rewrite clears before it edits a file
 * (docs/tech/rewrite/levers.md, "Cover before touching"):
 *
 *   bun run rewrite:coverage --cut <path>...   the surviving files that import what is cut or replaced
 *   bun run rewrite:coverage --unit <name>     a unit's own files, which a per-method rewrite fills in
 *   bun run rewrite:coverage <file>...         the named files
 *
 * Each file is read from coverage/lcov.info (`bun run test:coverage` writes
 * it) and held to the testing.md target of its slice, 70% where testing.md
 * names none. A file no test loads is not in the lcov at all, and counts as
 * 0%. The exit code is 1 while any file is below its target.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { findUnit } from './units.js'

export type FileCoverage = { lines: number; hit: number; functions: number; functionsHit: number }

export type Row = {
  path: string
  /** Line coverage in percent, or null when no test loads the file. */
  percent: number | null
  functionPercent: number | null
  target: number
}

const LCOV_PATH = 'coverage/lcov.info'

/** testing.md, "Coverage Targets"; the first matching prefix wins. */
const TARGETS: [prefix: string, percent: number][] = [
  ['src/providers/', 80],
  ['src/shared/', 75],
  ['src/tools/', 70],
  ['scripts/', 60],
]
const DEFAULT_TARGET = 70

export const targetFor = (path: string): number =>
  TARGETS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? DEFAULT_TARGET

/** Per file, keyed by its path from the repository root. */
export function parseLcov(text: string, root: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>()
  let current: FileCoverage | undefined
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    const key = line.slice(0, colon)
    const value = line.slice(colon + 1).trim()
    if (key === 'SF') {
      current = { lines: 0, hit: 0, functions: 0, functionsHit: 0 }
      files.set(value.startsWith('/') ? relative(root, value) : value, current)
    } else if (current !== undefined) {
      if (key === 'LF') current.lines = Number(value)
      else if (key === 'LH') current.hit = Number(value)
      else if (key === 'FNF') current.functions = Number(value)
      else if (key === 'FNH') current.functionsHit = Number(value)
    }
  }
  return files
}

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm
const EXTENSION_RE = /\.(?:[cm]?js|tsx?|jsx)$/
const NOT_PRODUCTION_RE = /\.test\.|\.d\.ts$|\/__tests__\/|\/__testutils__\//

const withoutExtension = (path: string): string => path.replace(EXTENSION_RE, '').replace(/\/$/, '')

/** The repository path a specifier points at, without its extension; null for a package. */
export function resolveSpecifier(importer: string, specifier: string): string | null {
  if (specifier.startsWith('src/')) return withoutExtension(specifier)
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return withoutExtension(join(dirname(importer), specifier))
  }
  return null
}

/**
 * The production files outside `cut` that import something inside it. Those
 * are the files that survive the cut and still have to change.
 */
export function importersOf(cut: string[], sources: Map<string, string>): string[] {
  const targets = cut.map(withoutExtension)
  const inside = (path: string) => targets.some(t => path === t || path.startsWith(`${t}/`))
  const importers: string[] = []
  for (const [path, source] of sources) {
    if (NOT_PRODUCTION_RE.test(path) || inside(withoutExtension(path))) continue
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const resolved = resolveSpecifier(path, match[1]!)
      if (resolved !== null && inside(resolved)) {
        importers.push(path)
        break
      }
    }
  }
  return importers.sort()
}

const percent = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((100 * part) / whole))

export function rowsFor(paths: string[], coverage: Map<string, FileCoverage>): Row[] {
  return paths
    .map(path => {
      const file = coverage.get(path)
      return {
        path,
        percent: file === undefined ? null : (percent(file.hit, file.lines) ?? 100),
        functionPercent: file === undefined ? null : percent(file.functionsHit, file.functions),
        target: targetFor(path),
      }
    })
    .sort((a, b) => (a.percent ?? -1) - (b.percent ?? -1) || a.path.localeCompare(b.path))
}

export const isBelowTarget = (row: Row): boolean => (row.percent ?? 0) < row.target

function productionSources(): Map<string, string> {
  const sources = new Map<string, string>()
  for (const dir of ['src', 'scripts']) {
    for (const path of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: REPO_ROOT })) {
      if (!NOT_PRODUCTION_RE.test(path)) sources.set(path, readFileSync(join(REPO_ROOT, path), 'utf8'))
    }
  }
  return sources
}

function filesOf(args: string[]): string[] {
  if (args[0] === '--cut') return importersOf(args.slice(1), productionSources())
  if (args[0] === '--unit') return findUnit(args[1]!).files.filter(path => !NOT_PRODUCTION_RE.test(path))
  return args
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('usage: rewrite:coverage --cut <path>... | --unit <name> | <file>...')
    process.exit(2)
  }
  const lcov = join(REPO_ROOT, LCOV_PATH)
  if (!existsSync(lcov)) {
    console.error(`${LCOV_PATH} is missing; run \`bun run test:coverage\` first.`)
    process.exit(2)
  }
  const rows = rowsFor(filesOf(args), parseLcov(readFileSync(lcov, 'utf8'), REPO_ROOT))
  const below = rows.filter(isBelowTarget)
  console.log(`${LCOV_PATH} from ${statSync(lcov).mtime.toISOString()}`)
  for (const row of rows) {
    const lines = row.percent === null ? 'not loaded' : `${row.percent}%`
    const functions = row.functionPercent === null ? '-' : `${row.functionPercent}%`
    console.log(`${isBelowTarget(row) ? '✗' : '✓'} ${lines.padStart(10)}  fn ${functions.padStart(4)}  target ${row.target}%  ${row.path}`)
  }
  console.log(`${rows.length} file(s), ${below.length} below target`)
  process.exit(below.length === 0 ? 0 : 1)
}
