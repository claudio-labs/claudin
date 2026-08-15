#!/usr/bin/env bun
/**
 * Restores, per specifier, the SHAPE its author wrote before the move —
 * `./sibling.js` stays `./sibling.js`, an alias stays an alias.
 *
 * Why shape is not cosmetic here: Bun's mock.module registry keys on the
 * specifier, so `./which.js` and `src/shared/proc/which.js` are two different
 * entries. Rewriting a sibling import to the alias merges them, and a stub
 * registered in one test file starts intercepting for the whole run —
 * src/platform/claudinInstallSurfaces.test.ts's execFileNoThrow stub reaching
 * src/shared/proc/execFileNoThrow.test.ts is the case that motivated this.
 * Rewriting the other way is just as wrong: it silently unhooks a pin other
 * files depend on.
 *
 * So the decision is made per resolved target, from HEAD:
 *   - HEAD wrote it relative, and the target is still at or below this file's
 *     directory → emit `./…`
 *   - anything else → emit the `src/…` alias
 *
 * An upward `../` is never emitted: that is the shape the reorg removed, and
 * the one the build silently stubs to a noop when it goes stale.
 *
 * Idempotent and bidirectional, so it can be re-run to correct an earlier pass.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DRY = process.argv.includes('--dry')

const PATTERNS = [
  /\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1/g,
  /\bmock\.module\s*\(\s*(['"])([^'"]+)\1/g,
]

const stem = (p: string): string => p.replace(/\.(ts|tsx|js|jsx)$/, '')

function renames(): Map<string, string> {
  const res = Bun.spawnSync(['git', 'diff', '--cached', '--name-status', '-M'], { cwd: REPO_ROOT })
  const map = new Map<string, string>()
  for (const line of res.stdout.toString().split('\n')) {
    const parts = line.split('\t')
    if (parts[0]?.startsWith('R') && parts.length === 3) map.set(parts[2]!, parts[1]!)
  }
  return map
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const newToOld = renames()
const oldToNew = new Map([...newToOld].map(([next, old]) => [old, next]))
/** old repo-relative stem → new repo-relative stem, for everything that moved. */
const movedStems = new Map([...oldToNew].map(([old, next]) => [stem(old), stem(next)]))

/** The set of targets this file wrote as `./…` before the move, as old stems. */
function relativeTargetsAtHead(oldPath: string): Set<string> {
  const res = Bun.spawnSync(['git', 'show', `HEAD:${oldPath}`], { cwd: REPO_ROOT })
  const targets = new Set<string>()
  if (res.exitCode !== 0) return targets
  const oldDir = dirname(oldPath)
  for (const pattern of PATTERNS) {
    for (const match of res.stdout.toString().matchAll(pattern)) {
      const specifier = match[2]!
      if (!specifier.startsWith('./')) continue
      const clean = specifier.split('?')[0]!
      targets.add(stem(relative(REPO_ROOT, resolve(REPO_ROOT, oldDir, clean))))
    }
  }
  return targets
}

let touched = 0
let toRelative = 0
let toAlias = 0

for (const file of walk(join(REPO_ROOT, 'src'))) {
  const relFile = relative(REPO_ROOT, file)
  const oldPath = newToOld.get(relFile) ?? relFile
  const wereRelative = relativeTargetsAtHead(oldPath)

  const dir = dirname(relFile)
  const original = readFileSync(file, 'utf8')
  let next = original

  for (const pattern of PATTERNS) {
    next = next.replace(pattern, (match, quote: string, specifier: string) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('src/')) return match
      const clean = specifier.split('?')[0]!
      const current = specifier.startsWith('src/')
        ? clean
        : relative(REPO_ROOT, resolve(REPO_ROOT, dir, clean))
      if (!existsSync(join(REPO_ROOT, stem(current) + '.ts')) &&
          !existsSync(join(REPO_ROOT, stem(current) + '.tsx'))) {
        return match
      }

      // Where this target lived before the move, so HEAD's shape can be looked up.
      const currentStem = stem(current)
      let oldStem = currentStem
      for (const [old, moved] of movedStems) {
        if (moved === currentStem) {
          oldStem = old
          break
        }
      }

      const down = relative(dir, dirname(current))
      const wantRelative = wereRelative.has(oldStem) && !down.startsWith('..')
      const desired = wantRelative
        ? `${down ? `./${down}/` : './'}${current.slice(dirname(current).length + 1)}`
        : current
      const desiredWithExt = `${stem(desired)}${clean.match(/\.(ts|tsx|js|jsx)$/)?.[0] ?? '.js'}`
      if (desiredWithExt === clean) return match

      if (wantRelative) toRelative++
      else toAlias++
      return match.replace(
        `${quote}${specifier}${quote}`,
        `${quote}${desiredWithExt}${specifier.slice(clean.length)}${quote}`,
      )
    })
  }

  if (next !== original) {
    touched++
    if (!DRY) writeFileSync(file, next)
  }
}

console.log(
  `${DRY ? 'would change' : 'changed'} ${touched} files: ${toRelative} → relative, ${toAlias} → alias`,
)
