/**
 * Finds the break-probe specs a rewrite has left behind:
 *
 *   bun run scripts/migrations/rewrite/stale-probes.ts                    report every spec
 *   bun run scripts/migrations/rewrite/stale-probes.ts --prune <spec>...  fix the named specs
 *
 * A probe is stale when its `find` no longer occurs exactly once in its
 * source, or the source is gone; a suite is stale when the test file is gone.
 * Once a unit is rewritten, the specs written for earlier refactors of the
 * same files quote code that no longer exists, and break-probe refuses the
 * whole spec because of them. land.ts prunes exactly those specs, the ones
 * sandbox.ts took out of the implementer's reach, so staleness that was
 * already there before the rewrite is reported and left alone.
 *
 * Pruning drops the stale probes and the missing suites, and deletes a spec
 * with nothing left to probe. It never touches a `rewrite-*.json`: a stale
 * probe there means a unit's own evidence is wrong, which is a finding to
 * fix, not to prune.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'

type Probe = { name: string; find: string; replace: string; source?: string }
type Spec = { test: string | string[]; source: string; probes: Probe[] }

export type Staleness = { probes: Probe[]; suites: string[]; total: number }

const PROBES_DIR = 'scripts/migrations/probes'

function occurrences(haystack: string, needle: string): number {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++
  return count
}

const readSpec = (spec: string) => JSON.parse(readFileSync(join(REPO_ROOT, spec), 'utf8')) as Spec
const suitesOf = (spec: Spec) => (Array.isArray(spec.test) ? spec.test : [spec.test])

export function staleness(specPath: string): Staleness {
  const spec = readSpec(specPath)
  const probes = spec.probes.filter(probe => {
    const source = join(REPO_ROOT, probe.source ?? spec.source)
    return !existsSync(source) || occurrences(readFileSync(source, 'utf8'), probe.find) !== 1
  })
  const suites = suitesOf(spec).filter(suite => !existsSync(join(REPO_ROOT, suite)))
  return { probes, suites, total: spec.probes.length }
}

/** Prunes one spec in place and says what it did. */
export function pruneSpec(specPath: string): string {
  if (basename(specPath).startsWith('rewrite-')) return `${specPath}: a rewrite spec, left for a fix by hand`
  const stale = staleness(specPath)
  if (stale.probes.length === 0 && stale.suites.length === 0) return `${specPath}: nothing stale`
  const spec = readSpec(specPath)
  const probes = spec.probes.filter(probe => !stale.probes.includes(probe))
  const test = suitesOf(spec).filter(suite => !stale.suites.includes(suite))
  if (probes.length === 0 || test.length === 0) {
    rmSync(join(REPO_ROOT, specPath))
    return `${specPath}: deleted, nothing left to probe`
  }
  writeFileSync(
    join(REPO_ROOT, specPath),
    `${JSON.stringify({ ...spec, test: test.length === 1 ? test[0] : test, probes }, null, 2)}\n`,
  )
  return `${specPath}: pruned ${stale.probes.length} stale probes and ${stale.suites.length} missing suites`
}

if (import.meta.main) {
  const pruneAt = process.argv.indexOf('--prune')
  if (pruneAt !== -1) {
    for (const spec of process.argv.slice(pruneAt + 1)) console.log(pruneSpec(spec))
    process.exit(0)
  }
  let staleSpecs = 0
  for (const entry of readdirSync(join(REPO_ROOT, PROBES_DIR)).filter(f => f.endsWith('.json')).sort()) {
    const specPath = `${PROBES_DIR}/${entry}`
    const stale = staleness(specPath)
    if (stale.probes.length === 0 && stale.suites.length === 0) continue
    staleSpecs++
    console.log(`${specPath}: ${stale.probes.length} of ${stale.total} probes stale, ${stale.suites.length} suites missing`)
    for (const probe of stale.probes) console.log(`  - ${probe.name}`)
    for (const suite of stale.suites) console.log(`  - suite ${suite}`)
  }
  console.log(staleSpecs === 0 ? 'no stale probes' : `${staleSpecs} spec(s) with stale probes`)
}
