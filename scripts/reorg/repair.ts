#!/usr/bin/env bun
/**
 * Repairs every module specifier the move left dangling, using git's own rename
 * record as the source of truth rather than re-deriving it from the manifest.
 *
 * Two cases the manifest-driven rewrite in apply.ts cannot see:
 *
 *  1. A file MOVED and its `./sibling.js` did not. `src/services/install/autoUpdater.ts`
 *     imported `./semver.js`; now at `src/services/install/`, that specifier
 *     names a file that was never there. The rewrite only knew how to follow
 *     references INTO moved files, not references FROM them.
 *  2. A specifier carrying no extension. `import … from 'src/utils/stableStringify'`
 *     never matched the `src/utils/data/stableStringify.` key, whose trailing dot is
 *     what stops it from swallowing a longer sibling name.
 *  3. A target that exists only as a `.d.ts` — a subsystem this fork never
 *     received, declared next to where it would live. It resolves for tsc and
 *     for nothing else, so a moved file whose relative specifier names one
 *     silently starts pointing at a directory that has no such declaration.
 *
 * Both are found the same way: resolve the specifier against the file's ORIGINAL
 * directory, look the target up in the rename map, and emit the alias of where
 * it ended up. Anything that still fails to resolve is reported rather than
 * guessed at — a wrong guess here builds green and returns null at runtime.
 *
 *   bun scripts/reorg/repair.ts --dry
 *   bun scripts/reorg/repair.ts
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DRY = process.argv.includes('--dry')

const SPECIFIER_PATTERNS = [
  /\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1/g,
  /\bmock\.module\s*\(\s*(['"])([^'"]+)\1/g,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const stem = (p: string): string =>
  p.replace(/\.d\.ts$/, '').replace(/\.(ts|tsx|js|jsx)$/, '')

/** old repo-relative path → new repo-relative path, straight from `git mv`. */
function renameMap(): Map<string, string> {
  const res = Bun.spawnSync(['git', 'diff', '--cached', '--name-status', '-M'], { cwd: REPO_ROOT })
  const map = new Map<string, string>()
  for (const line of res.stdout.toString().split('\n')) {
    const parts = line.split('\t')
    if (parts[0]?.startsWith('R') && parts.length === 3) map.set(parts[1], parts[2])
  }
  return map
}

/** The file a specifier names, if it is on disk under any of the real extensions. */
function existingTarget(absNoExt: string): string | null {
  for (const candidate of [
    `${absNoExt}.ts`,
    `${absNoExt}.tsx`,
    `${absNoExt}.js`,
    `${absNoExt}.d.ts`,
    absNoExt,
    join(absNoExt, 'index.ts'),
    join(absNoExt, 'index.tsx'),
    join(absNoExt, 'index.d.ts'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function main(): void {
  const renames = renameMap()
  const newToOld = new Map([...renames].map(([old, next]) => [next, old]))
  const byStem = new Map([...renames].map(([old, next]) => [stem(old), next]))

  let touched = 0
  let fixed = 0
  const unresolved: string[] = []

  for (const file of walk(join(REPO_ROOT, 'src'))) {
    const relFile = relative(REPO_ROOT, file)
    const original = readFileSync(file, 'utf8')
    let next = original

    for (const pattern of SPECIFIER_PATTERNS) {
      next = next.replace(pattern, (match, quote: string, specifier: string) => {
        if (!specifier.startsWith('.') && !specifier.startsWith('src/')) return match
        const clean = specifier.split('?')[0]!
        const wasMoved = newToOld.has(relFile)

        // A relative specifier inside a file that MOVED is never trustworthy at
        // face value, even when it resolves: `./errors.js` in a file now sitting
        // in src/services/api/ finds that directory's own errors.ts, a different
        // module with the same name. Such a specifier resolves green and imports
        // the wrong thing, so it is always re-derived from the old location.
        const trustAsIs = !(wasMoved && specifier.startsWith('.'))

        const here = specifier.startsWith('src/')
          ? join(REPO_ROOT, clean)
          : resolve(dirname(file), clean)
        if (trustAsIs && existingTarget(stem(here))) return match

        // Resolve again from where this file used to live.
        const oldDir = wasMoved ? dirname(join(REPO_ROOT, newToOld.get(relFile)!)) : dirname(file)
        const wanted = specifier.startsWith('src/') ? join(REPO_ROOT, clean) : resolve(oldDir, clean)
        // Either the target moved too, or it stayed put and only this file
        // moved away from it — both need the alias, and only a target that
        // exists in neither place is genuinely dead.
        const stillThere = existingTarget(stem(wanted))
        const moved =
          byStem.get(stem(relative(REPO_ROOT, wanted))) ??
          (stillThere ? relative(REPO_ROOT, stillThere) : undefined)

        if (!moved) {
          unresolved.push(`${relFile} → ${specifier}`)
          return match
        }

        fixed++
        // An asset import (`…/prompt.txt`) keeps its own path: only a module
        // specifier gets the `.js` this codebase writes for a `.ts` file.
        const jsish = clean.match(/\.(ts|tsx|js|jsx)$/)?.[0]
        const isAsset = /\.[^./]+$/.test(clean) && !jsish

        // Keep the author's shape. A `./sibling.js` whose target travelled to
        // the same new directory must come back out as `./sibling.js`, not as
        // the alias: the two are DIFFERENT keys to Bun's mock registry, and
        // collapsing them silently widens every stub's blast radius. That is
        // what made src/services/notifier.platform.test.ts's module-scope stub
        // of execFileNoThrow start intercepting utils/proc/which.js for the
        // whole run. Only a target that would need `../` gets the alias, since
        // an upward specifier is the failure mode this reorg exists to remove.
        //
        // One target overrides all of that: a module that exists only as a
        // declaration is absent at RUNTIME, and scripts/build.ts replaces it
        // with a noop stub for a relative specifier only (build.ts:561). Alias
        // one and the build stops stubbing it and fails to resolve it instead,
        // so a declaration-only target stays relative, `../` and all.
        const inside = relative(dirname(file), join(REPO_ROOT, moved))
        const declarationOnly = moved.endsWith('.d.ts')
        const keepRelative =
          specifier.startsWith('.') && (declarationOnly || !inside.startsWith('..'))
        const base = keepRelative ? (inside.startsWith('..') ? inside : `./${inside}`) : moved
        const replacement = isAsset
          ? `${base}${specifier.slice(clean.length)}`
          : `${stem(base)}${jsish ?? '.js'}${specifier.slice(clean.length)}`
        return match.replace(`${quote}${specifier}${quote}`, `${quote}${replacement}${quote}`)
      })
    }

    if (next !== original) {
      touched++
      if (!DRY) writeFileSync(file, next)
    }
  }

  console.log(`${DRY ? 'would fix' : 'fixed'} ${fixed} specifiers across ${touched} files`)
  if (unresolved.length > 0) {
    console.log(`\nstill unresolved (${unresolved.length}) — these were already dead before the move:`)
    for (const line of [...new Set(unresolved)].sort().slice(0, 60)) console.log(`  ${line}`)
  }
}

main()
