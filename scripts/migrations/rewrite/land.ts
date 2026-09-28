/**
 * Brings a finished sandbox back into the checkout:
 *
 *   bun run scripts/migrations/rewrite/land.ts <sandbox>           show what would change
 *   bun run scripts/migrations/rewrite/land.ts <sandbox> --apply   apply it
 *
 * The sandbox is diffed against `<sandbox>.base`, the tree sandbox.ts made it
 * from, so only what the agent did is carried over. A file the checkout also
 * changed since that base is merged with git merge-file; one whose edits
 * overlap is a conflict, and nothing is applied while there is one. A removal
 * applies only to the unit's own files and inherited tests;
 * whatever else sandbox.ts took out was setup, not work, and an agent that
 * deleted a file outside its unit is reported instead of followed.
 *
 * Applying an implementation also reports the stale probes in the older specs
 * sandbox.ts took out because they probe the unit's files. They are reported,
 * not pruned: each proves one of this project's own tests, and the behaviour
 * it guards usually still exists in the new code, so the probe is re-pointed
 * at the line that now carries it. Prune one (stale-probes.ts --prune) only
 * when the spec dropped that behaviour.
 *
 * An implementation also lists every added or changed file that still matches
 * inherited code. The CI ratchet cannot be the review: a file rewritten at its
 * old path keeps the old, higher count in the baseline, so the ratchet passes
 * it whatever it holds. Each file listed is either reworded or recorded as
 * residue in the spec's Outcome.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { loadReference } from '../../verify/provenance/reference.js'
import { isScanned, matchFile } from '../../verify/provenance/scan.js'
import { staleness } from './stale-probes.js'
import { findUnit, probeSpecPath, type SandboxRecord } from './units.js'

const SKIP_RE = /(^|\/)(node_modules|dist|coverage|\.git)(\/|$)|^\.sandbox\.json$/

function files(root: string, dir = root, out = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const rel = relative(root, path)
    if (SKIP_RE.test(rel)) continue
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat?.isDirectory()) files(root, path, out)
    else if (stat?.isFile()) out.add(rel)
  }
  return out
}

function sameContent(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b))
}

/**
 * A file the checkout and the sandbox both changed since the base, merged the
 * way git merges: null when the two edits touch the same lines. Units that
 * run side by side meet in shared files (a barrel, a snapshot), and the later
 * one to land keeps the earlier one's edit.
 */
function mergedWithCheckout(path: string): string | null {
  if (!existsSync(join(REPO_ROOT, path))) return null
  const result = spawnSync(
    'git',
    ['merge-file', '-p', '-q', join(REPO_ROOT, path), join(base, path), join(sandbox, path)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return result.status === 0 ? result.stdout : null
}

const [sandbox] = process.argv.slice(2)
if (sandbox === undefined) {
  console.error('usage: bun run scripts/migrations/rewrite/land.ts <sandbox> [--apply]')
  process.exit(2)
}
const apply = process.argv.includes('--apply')
const base = `${sandbox}.base`
const record = JSON.parse(readFileSync(join(base, '.sandbox.json'), 'utf8')) as SandboxRecord
const unit = findUnit(record.unit)
const owned = new Set([...unit.files, ...unit.tests])
const byDesign = (path: string) =>
  owned.has(path) || path === probeSpecPath(unit.name) || path.startsWith('docs/tech/rewrite/')
const removedBySetup = (path: string) => record.removed.some(r => path === r || path.startsWith(`${r}/`))

const inSandbox = files(sandbox)
const inBase = files(base)
const added: string[] = []
const changed: string[] = []
const removed: string[] = []
const strayRemovals: string[] = []
for (const path of inSandbox) {
  if (!inBase.has(path)) added.push(path)
  else if (!sameContent(join(sandbox, path), join(base, path))) changed.push(path)
}
for (const path of inBase) {
  if (inSandbox.has(path)) continue
  if (owned.has(path)) removed.push(path)
  else if (!removedBySetup(path)) strayRemovals.push(path)
}

const movedOn = (path: string) => !sameContent(join(REPO_ROOT, path), join(base, path))
const merged = new Map<string, string>()
for (const path of changed.filter(movedOn)) {
  const content = mergedWithCheckout(path)
  if (content !== null) merged.set(path, content)
}
const conflicts = [
  ...changed.filter(path => movedOn(path) && !merged.has(path)),
  ...removed.filter(movedOn),
  ...added.filter(path => existsSync(join(REPO_ROOT, path)) && !sameContent(join(REPO_ROOT, path), join(sandbox, path))),
]

const show = (label: string, list: string[]) => {
  if (list.length > 0) console.log(`${label} (${list.length}):\n  ${[...list].sort().join('\n  ')}`)
}
console.log(`${record.mode} sandbox of ${unit.name}, made from ${record.sha.slice(0, 8)}`)
show('added', added)
show('changed', changed)
show('removed', removed)
show('changed outside the unit, review', changed.filter(path => !byDesign(path)))
show('deleted outside the unit, NOT applied', strayRemovals)
show('merged with what the checkout changed since the base', [...merged.keys()])
show('CONFLICT: the checkout changed these since the base', conflicts)

if (record.mode === 'impl') {
  const reference = loadReference()
  // Every added file is the implementer's; a changed file outside the unit
  // keeps whatever inherited count it had, which the ratchet already holds.
  const inherited = [...added, ...changed.filter(byDesign)]
    .filter(isScanned)
    .map(path => {
      const match = matchFile(path, readFileSync(join(sandbox, path), 'utf8'), reference)
      return { path, lines: new Set([...match.claudeCode, ...match.openclaude]).size }
    })
    .filter(file => file.lines > 0)
  show(
    'still matching inherited code: reword each, or record it as residue in the spec',
    inherited.map(file => `${file.path} (${file.lines})`),
  )
}

if (!apply) process.exit(0)
if (conflicts.length > 0) {
  console.error('Nothing applied: resolve the conflicts first.')
  process.exit(1)
}
for (const path of [...added, ...changed]) {
  mkdirSync(dirname(join(REPO_ROOT, path)), { recursive: true })
  const content = merged.get(path)
  if (content === undefined) copyFileSync(join(sandbox, path), join(REPO_ROOT, path))
  else writeFileSync(join(REPO_ROOT, path), content)
}
if (removed.length > 0) {
  const result = spawnSync('git', ['rm', '-q', '--', ...removed], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git rm failed:\n${result.stderr}`)
}
console.log(`applied: ${added.length} added, ${changed.length} changed, ${removed.length} removed`)
if (record.mode === 'impl') {
  const olderSpecs = record.removed.filter(
    path => path.startsWith('scripts/migrations/probes/') && path !== probeSpecPath(unit.name),
  )
  for (const spec of olderSpecs) {
    if (!existsSync(join(REPO_ROOT, spec))) continue
    const stale = staleness(spec)
    if (stale.probes.length === 0 && stale.suites.length === 0) continue
    console.log(`${spec}: re-point ${stale.probes.length} stale probes, ${stale.suites.length} suites missing`)
    for (const probe of stale.probes) console.log(`  - ${probe.name}`)
    for (const suite of stale.suites) console.log(`  - suite ${suite}`)
  }
}
