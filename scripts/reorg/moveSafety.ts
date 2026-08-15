#!/usr/bin/env bun
/**
 * Reports every relative module specifier the manifest is about to break.
 *
 * `apply.ts` rewrites the `src/…` alias everywhere it appears, and repairs
 * relative specifiers that point AT something being moved. Neither pass can see
 * the third case: a relative specifier inside a file that moves, aimed at a file
 * that moves somewhere ELSE (or stays). `./providerConfig.js` in
 * `services/api/codexShim.test.ts` is the shape — the test goes to
 * `providers/shims/`, its target to `providers/presets/`, and nothing complains
 * until the assertion that depends on it runs.
 *
 * Two of the forms checked here are invisible to tsc AND to the build's
 * pre-scan, so the suite is their only gate (see .claudin/rules/testing.md):
 *
 *  - `mock.module('./x.js')`, which `normalizeImports.ts` leaves relative on
 *    purpose — aliasing it merges registrations and changes which mock wins.
 *  - a cache-busting template import, `` import(`./x.js?t=${Date.now()}`) ``,
 *    which an alias codemod skips because a computed specifier cannot be
 *    rewritten safely.
 *
 * Usage:
 *   bun scripts/reorg/moveSafety.ts            # report breakages
 *   bun scripts/reorg/moveSafety.ts --all      # also list what stays intact
 *   bun scripts/reorg/moveSafety.ts --fix      # rewrite each to the src/ alias
 *
 * `--fix` aliases the specifier to the target's CURRENT path, not its
 * destination: from there `apply.ts` carries it forward on every later group,
 * which is the whole point of the alias.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { GROUPS } from './manifest.ts'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')
const VERBOSE = process.argv.includes('--all')
const FIX = process.argv.includes('--fix')

/** Static specifiers, then the computed one. Group 2 is always the specifier. */
const PATTERNS: readonly RegExp[] = [
  /\bfrom\s*(['"])(\.\.?\/[^'"]*)\1/g,
  /\bimport\s*(['"])(\.\.?\/[^'"]*)\1/g,
  /\bimport\s*\(\s*(['"])(\.\.?\/[^'"]*)\1/g,
  /\brequire\s*\(\s*(['"])(\.\.?\/[^'"]*)\1/g,
  /\bmock\.module\s*\(\s*(['"])(\.\.?\/[^'"]*)\1/g,
  /\b(?:import|require)\s*\(\s*(`)(\.\.?\/[^`?]*)/g,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/**
 * Every source path the manifest moves, mapped to where it lands — companion
 * tests and snapshots included, because those travel with the file that names
 * them and their specifiers break the same way.
 */
function buildDestinations(): Map<string, string> {
  const dest = new Map<string, string>()
  const claim = (from: string, to: string): void => {
    if (!dest.has(from)) dest.set(from, to)
  }

  for (const group of GROUPS) {
    for (const { from, to } of group.dirs ?? []) {
      const abs = join(REPO_ROOT, from)
      if (!existsSync(abs)) continue
      for (const file of walk(abs)) {
        const rel = relative(REPO_ROOT, file)
        claim(rel, join(to, relative(abs, file)))
      }
    }
    for (const { from, files, to } of group.files ?? []) {
      const fromDir = join(REPO_ROOT, from)
      if (!existsSync(fromDir)) continue
      const siblings = readdirSync(fromDir)
      for (const file of files) {
        if (!existsSync(join(fromDir, file))) continue
        const stem = file.replace(/\.(tsx?)$/, '')
        const carry = [
          file,
          ...siblings.filter(
            c => c !== file && c.startsWith(`${stem}.`) && /\.test\.tsx?$/.test(c),
          ),
        ]
        for (const name of carry) {
          claim(join(from, name), join(to, name))
          const snap = join(from, '__snapshots__', `${name}.snap`)
          if (existsSync(join(REPO_ROOT, snap))) {
            claim(snap, join(to, '__snapshots__', `${name}.snap`))
          }
        }
      }
    }
  }
  return dest
}

/** A `.js` specifier names a `.ts`/`.tsx` on disk; a bare directory its index. */
function resolveTarget(abs: string): string | null {
  const stripped = abs.replace(/\.(js|jsx|ts|tsx)$/, '')
  for (const candidate of [
    abs,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.js`,
    `${stripped}.json`,
    join(abs, 'index.ts'),
    join(abs, 'index.tsx'),
    join(abs, 'index.js'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

type Finding = {
  file: string
  specifier: string
  alias: string
  fileTo: string
  targetTo: string
}

function main(): void {
  const dest = buildDestinations()
  const at = (rel: string): string => dest.get(rel) ?? rel

  const broken: Finding[] = []
  let intact = 0

  for (const file of walk(SRC_ROOT).filter(f => /\.(ts|tsx)$/.test(f))) {
    const relFile = relative(REPO_ROOT, file)
    const text = readFileSync(file, 'utf8')

    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[2]!
        const target = resolveTarget(resolve(dirname(file), specifier))
        if (!target) continue // unresolved today — build stubs it, not our problem

        const relTarget = relative(REPO_ROOT, target)
        const fileTo = at(relFile)
        const targetTo = at(relTarget)
        if (dirname(fileTo) === dirname(relFile) && dirname(targetTo) === dirname(relTarget)) {
          intact++
          continue
        }

        // The specifier keeps its written extension; compare directories only.
        const before = relative(dirname(relFile), dirname(relTarget)) || '.'
        const after = relative(dirname(fileTo), dirname(targetTo)) || '.'
        if (before === after) {
          intact++
          continue
        }
        broken.push({
          file: relFile,
          specifier,
          alias: relTarget.replace(/\.tsx?$/, specifier.match(/\.\w+$/)?.[0] ?? '.js'),
          fileTo,
          targetTo,
        })
      }
    }
  }

  if (FIX) {
    const byFile = new Map<string, Finding[]>()
    for (const f of broken) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f])
    for (const [file, findings] of byFile) {
      const abs = join(REPO_ROOT, file)
      let text = readFileSync(abs, 'utf8')
      for (const f of new Map(findings.map(f => [f.specifier, f])).values()) {
        text = text.replaceAll(`'${f.specifier}'`, `'${f.alias}'`)
        text = text.replaceAll(`"${f.specifier}"`, `"${f.alias}"`)
        text = text.replaceAll(`\`${f.specifier}?`, `\`${f.alias}?`)
      }
      writeFileSync(abs, text)
    }
    console.log(`fixed ${broken.length} specifier(s) across ${byFile.size} file(s)`)
    return
  }

  console.log(`${broken.length} relative specifier(s) would break; ${intact} stay intact\n`)
  for (const f of broken) {
    console.log(`${f.file}`)
    console.log(`   '${f.specifier}'`)
    console.log(`   file   → ${f.fileTo}`)
    console.log(`   target → ${f.targetTo}`)
    console.log(`   fix: '${f.alias}'\n`)
  }
  if (VERBOSE) console.log(`(${intact} specifiers keep the same relative offset)`)
  process.exitCode = broken.length > 0 ? 1 : 0
}

main()
