#!/usr/bin/env bun
/**
 * Executes the move manifest: `git mv` every file, drag its snapshot along, then
 * rewrite the module path everywhere it is named.
 *
 * The rewrite is a literal substring replacement, which is only safe because
 * every parent-traversing specifier was normalized to the `src/…` alias first
 * (see normalizeImports.ts). Nothing here has to reason about relative depth.
 *
 * Two properties keep it honest:
 *  - a destination that already exists aborts the whole run before any file moves
 *  - the replacement keys carry a trailing `/` or `.`, so `src/services/config/config.`
 *    cannot swallow `src/services/config/configConstants.ts`
 *
 * Usage:
 *   bun scripts/reorg/apply.ts --dry              # plan only
 *   bun scripts/reorg/apply.ts --group=session    # one group
 *   bun scripts/reorg/apply.ts                    # everything
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { GROUPS } from './manifest.ts'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DRY = process.argv.includes('--dry')
const ONLY = process.argv.find(a => a.startsWith('--group='))?.slice('--group='.length)

/** Trees whose text may name a module path. */
const REWRITE_ROOTS = ['src', 'scripts', 'docs', '.claudin']
const REWRITE_FILES = ['package.json', 'AGENTS.md', 'README.md', 'knip.json']
const REWRITE_EXT = /\.(ts|tsx|json|md|mjs|cjs|js)$/

type Move = { from: string; to: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function git(args: string[]): void {
  const res = Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT })
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr.toString()}`)
  }
}
/**
 * git tracks files, not directories, so a directory emptied by `git mv` stays on
 * disk — and an empty `src/utils/fs/` still reads as "not moved yet" to anyone
 * checking the tree. Prunes bottom-up so a parent emptied by its children goes
 * too.
 */
function pruneEmptyDirs(dir: string): boolean {
  let empty = true
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!pruneEmptyDirs(full)) empty = false
    } else empty = false
  }
  if (empty && dir !== join(REPO_ROOT, 'src')) rmdirSync(dir)
  return empty
}


/**
 * Every test that belongs to `basename.ts`: `basename.test.ts` and the
 * `basename.<what>.test.ts` variants, but never `basenameOther.test.ts` — the
 * dot is what separates a suffix from a different module.
 */
function companionTests(dir: string, file: string): string[] {
  const stem = file.replace(/\.(ts|tsx)$/, '')
  return readdirSync(dir).filter(
    candidate =>
      candidate !== file &&
      candidate.startsWith(`${stem}.`) &&
      /\.test\.tsx?$/.test(candidate),
  )
}

function snapshotFor(dir: string, testFile: string): string | null {
  const snap = join(dir, '__snapshots__', `${testFile}.snap`)
  return existsSync(snap) ? snap : null
}

/**
 * Which slice of the manifest to collect, and how strictly.
 *
 *  - `group`   the `--group=` one alone (or everything when no group is named),
 *              and every path it names must still exist. This is what MOVES.
 *  - `through` every group up to AND INCLUDING that one, leniently: the earlier
 *              groups already ran, so their sources are gone. This is the map the
 *              ./-relative repair needs, and stopping at the current group is the
 *              whole point — repairing with the FULL manifest rewrites specifiers
 *              for directories that have NOT moved yet, which silently breaks the
 *              build for every group still ahead.
 */
type Scope = 'group' | 'through'

function collectMoves(scope: Scope = 'group'): {
  moves: Move[]
  rewrites: Map<string, string>
} {
  const strict = scope === 'group'
  const moves: Move[] = []
  // A file can be claimed twice: `EffortPicker.tsx` and `EffortPicker.layout.ts`
  // both drag `EffortPicker.layout.test.ts` as a companion. The second `git mv`
  // would fail on a path that no longer exists, so queue each source once.
  const queued = new Set<string>()
  const push = (move: Move): void => {
    if (queued.has(move.from)) return
    queued.add(move.from)
    moves.push(move)
  }
  // Module-path prefix → replacement. Keys keep their trailing `/` or `.`.
  const rewrites = new Map<string, string>()

  for (const group of GROUPS) {
    if (ONLY && scope === 'group' && group.name !== ONLY) continue

    for (const { from, to } of group.dirs ?? []) {
      const abs = join(REPO_ROOT, from)
      if (!existsSync(abs)) {
        // Already moved by an earlier run — its rewrite still has to be known.
        if (strict) throw new Error(`manifest names a missing directory: ${from}`)
      } else {
        for (const file of walk(abs)) {
          const rel = relative(abs, file)
          push({ from: relative(REPO_ROOT, file), to: join(to, rel) })
        }
      }
      rewrites.set(`${from}/`, `${to}/`)
    }

    for (const { from, files, to } of group.files ?? []) {
      const fromDir = join(REPO_ROOT, from)
      for (const file of files) {
        const abs = join(fromDir, file)
        if (!existsSync(abs)) {
          if (strict) throw new Error(`manifest names a missing file: ${from}/${file}`)
        } else {
          const carry = [file, ...companionTests(fromDir, file)]
          for (const name of carry) {
            push({ from: join(from, name), to: join(to, name) })
            const snap = snapshotFor(fromDir, name)
            if (snap) {
              push({
                from: relative(REPO_ROOT, snap),
                to: join(to, '__snapshots__', basename(snap)),
              })
            }
          }
        }
        // `d\.ts` first: on `foo.d.ts` the `tsx?` arm would leave a `foo.d` stem.
        const stem = file.replace(/\.(d\.ts|tsx?)$/, '')
        rewrites.set(`${from}/${stem}.`, `${to}/${stem}.`)
      }
    }

    if (ONLY && group.name === ONLY) break
  }

  return { moves, rewrites }
}

/**
 * A specifier like `./sessionStorage/pure/paths.js` names a moved file without
 * ever spelling `src/utils/`, so the substring rewrite below cannot see it.
 * These survived normalizeImports precisely because they do not traverse
 * upward — which was safe right up until the directory beside them moved.
 *
 * This pass resolves each relative specifier against its own file and, when the
 * result lands under something the manifest moved, replaces it with the alias
 * of where it went. Resolving is what makes it precise: `./foo/` in two
 * different directories are two different modules.
 */
function repairRelativeSpecifiers(rewrites: Map<string, string>): number {
  const patterns = [
    /\bfrom\s*(['"])(\.[^'"]*)\1/g,
    /\bimport\s*(['"])(\.[^'"]*)\1/g,
    /\bimport\s*\(\s*(['"])(\.[^'"]*)\1/g,
    /\brequire\s*\(\s*(['"])(\.[^'"]*)\1/g,
    /\bmock\.module\s*\(\s*(['"])(\.[^'"]*)\1/g,
  ]
  const ordered = [...rewrites.entries()].sort((a, b) => b[0].length - a[0].length)

  const targets: string[] = []
  for (const root of ['src', 'scripts']) {
    const abs = join(REPO_ROOT, root)
    if (existsSync(abs)) targets.push(...walk(abs).filter(f => /\.(ts|tsx)$/.test(f)))
  }

  let touched = 0
  for (const file of targets) {
    const original = readFileSync(file, 'utf8')
    let next = original
    for (const pattern of patterns) {
      next = next.replace(pattern, (match, quote: string, specifier: string) => {
        const resolved = relative(REPO_ROOT, resolve(dirname(file), specifier))
        const hit = ordered.find(([from]) => resolved.startsWith(from))
        if (!hit) return match
        const replacement = hit[1] + resolved.slice(hit[0].length)
        return match.replace(`${quote}${specifier}${quote}`, `${quote}${replacement}${quote}`)
      })
    }
    if (next !== original) {
      touched++
      if (!DRY) writeFileSync(file, next)
    }
  }
  return touched
}

function applyRewrites(rewrites: Map<string, string>): number {
  const targets: string[] = []
  for (const root of REWRITE_ROOTS) {
    const abs = join(REPO_ROOT, root)
    if (existsSync(abs)) targets.push(...walk(abs).filter(f => REWRITE_EXT.test(f)))
  }
  for (const file of REWRITE_FILES) {
    const abs = join(REPO_ROOT, file)
    if (existsSync(abs)) targets.push(abs)
  }

  // Longest key first: `src/services/shell/powershell/` must win over
  // `src/services/shell/`, which would otherwise claim the same text.
  const ordered = [...rewrites.entries()].sort((a, b) => b[0].length - a[0].length)

  let touched = 0
  for (const file of targets) {
    const original = readFileSync(file, 'utf8')
    let next = original
    for (const [from, to] of ordered) next = next.replaceAll(from, to)
    if (next !== original) {
      touched++
      if (!DRY) writeFileSync(file, next)
    }
  }
  return touched
}

function main(): void {
  const { moves, rewrites } = collectMoves()

  const collisions = moves.filter(m => existsSync(join(REPO_ROOT, m.to)))
  if (collisions.length > 0) {
    console.error(`❌ ${collisions.length} destination(s) already exist — nothing was moved:`)
    for (const c of collisions) console.error(`   ${c.from} → ${c.to}`)
    process.exit(1)
  }

  console.log(`${DRY ? 'would move' : 'moving'} ${moves.length} files`)
  console.log(`${rewrites.size} path prefixes to rewrite`)

  if (!DRY) {
    for (const move of moves) {
      const destDir = join(REPO_ROOT, dirname(move.to))
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      git(['mv', move.from, move.to])
    }
    pruneEmptyDirs(join(REPO_ROOT, 'src'))
  }

  const touched = applyRewrites(rewrites)
  console.log(`${DRY ? 'would rewrite' : 'rewrote'} paths in ${touched} files`)

  const repaired = repairRelativeSpecifiers(collectMoves('through').rewrites)
  console.log(`${DRY ? 'would repair' : 'repaired'} ./-relative specifiers in ${repaired} files`)

  if (DRY) {
    console.log('\nsample:')
    for (const move of moves.slice(0, 15)) console.log(`  ${move.from} → ${move.to}`)
  }
}

main()
