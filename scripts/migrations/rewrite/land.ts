/**
 * Brings a finished sandbox back into the checkout:
 *
 *   bun run scripts/migrations/rewrite/land.ts <sandbox>           show what would change
 *   bun run scripts/migrations/rewrite/land.ts <sandbox> --apply   apply it
 *
 * The sandbox is diffed against `<sandbox>.base`, the tree sandbox.ts made it
 * from, so only what the agent did is carried over. A file the checkout
 * changed since that base is a conflict, and nothing is applied while there
 * is one. A removal applies only to the unit's own files and inherited tests;
 * whatever else sandbox.ts took out was setup, not work, and an agent that
 * deleted a file outside its unit is reported instead of followed.
 *
 * Applying an implementation also prunes the older probe specs sandbox.ts
 * took out because they probe the unit's files: their lines are gone now
 * (stale-probes.ts).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { pruneSpec } from './stale-probes.js'
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

const conflicts = [
  ...[...changed, ...removed].filter(path => !sameContent(join(REPO_ROOT, path), join(base, path))),
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
show('CONFLICT: the checkout changed these since the base', conflicts)

if (!apply) process.exit(0)
if (conflicts.length > 0) {
  console.error('Nothing applied: resolve the conflicts first.')
  process.exit(1)
}
for (const path of [...added, ...changed]) {
  mkdirSync(dirname(join(REPO_ROOT, path)), { recursive: true })
  copyFileSync(join(sandbox, path), join(REPO_ROOT, path))
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
  for (const spec of olderSpecs) console.log(pruneSpec(spec))
}
