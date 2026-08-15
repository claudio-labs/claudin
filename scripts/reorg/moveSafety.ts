#!/usr/bin/env bun
/**
 * Reports every cache-busting TEMPLATE import the manifest is about to break.
 *
 * `apply.ts` covers the quoted forms — it rewrites the `src/…` alias everywhere
 * it appears and repairs `from`/`import`/`require`/`mock.module` relatives from
 * both sides of a move. What it cannot cover is a specifier inside a template
 * literal:
 *
 *     import(`./providerConfig.js?ts=${Date.now()}`)
 *
 * Tests use that shape to force a fresh module instance, and every codemod in
 * the repo skips it on purpose: a computed specifier cannot be rewritten
 * blindly. It is also invisible to tsc AND to the build's pre-scan, so the suite
 * is its only gate (see .claudin/rules/testing.md) — and it only fails when the
 * file and the module it re-imports land in different directories, which is
 * exactly what splitting `services/api/` seven ways does to
 * `codexShim.test.ts` → `./providerConfig.js`.
 *
 * Usage:
 *   bun scripts/reorg/moveSafety.ts            # report breakages
 *   bun scripts/reorg/moveSafety.ts --all      # also list what stays intact
 *   bun scripts/reorg/moveSafety.ts --fix      # rewrite each to the src/ alias
 *
 * `--fix` aliases the specifier to the target's CURRENT path, not its
 * destination: from there `apply.ts` carries it forward on every later group,
 * which is the whole point of the alias. Only a target that is a real module is
 * ever aliased — a `.d.ts`-only stub has to stay relative or the build stops
 * stubbing it and fails outright.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { GROUPS } from './manifest.ts'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')
const VERBOSE = process.argv.includes('--all')
const FIX = process.argv.includes('--fix')

/** Only the computed form; apply.ts owns the quoted ones. Group 2 is the path. */
const PATTERNS: readonly RegExp[] = [
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

/**
 * A `.js` specifier names a `.ts`/`.tsx` on disk; a bare directory its index.
 *
 * `.d.ts` counts, and has to: the fork carries ~107 ambient declarations for
 * subsystems it never received, and a `import type … from './x.js'` against one
 * of those resolves for tsc while the build erases it. Leave them out and the
 * checker reports nothing while the move breaks the typecheck.
 */
function resolveTarget(abs: string): string | null {
  const stripped = abs.replace(/\.(js|jsx|ts|tsx)$/, '')
  for (const candidate of [
    abs,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.d.ts`,
    `${stripped}.js`,
    `${stripped}.json`,
    join(abs, 'index.ts'),
    join(abs, 'index.tsx'),
    join(abs, 'index.d.ts'),
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

/**
 * The other blind spot: a path written as a BARE string, without the `src/`
 * prefix that `apply.ts`'s substring rewrite keys on.
 *
 *   file('services/config/managedEnvConstants.ts')                  // fs read
 *   join(import.meta.dir, '../../services/config/config.ts')        // fs read
 *   pluginSource.match(/'services\/analytics\/growthbook': `…`/)    // assertion
 *   expect(content).toContain('services/lifecycleHooks/ssrfGuard.js')
 *
 * None of these is a module specifier, so tsc and the build pre-scan are both
 * blind and the suite is the only gate — which is exactly how the platform group
 * broke nine tests across four files. Reported, never auto-fixed: whether the
 * right repair is a new prefix, a repo-root anchor or a different assertion is a
 * judgement call each time.
 *
 * Known gap: a path split across arguments — `join(ROOT, 'src', 'main.tsx')` —
 * is invisible here too. Prefer writing those as one string.
 */
function reportBareStringPaths(dest: Map<string, string>): number {
  // Longest first so `services/analytics/growthbook` wins over `services/`.
  const prefixes = [...new Set([...dest.keys()].map(k => k.replace(/^src\//, '')))]
    .filter(p => p.includes('/'))
    .sort((a, b) => b.length - a.length)

  const STRING = /(['"`])([^'"`\n]{6,200})\1/g
  const hits: { file: string; literal: string; movesTo: string }[] = []

  for (const file of [
    ...walk(SRC_ROOT),
    ...walk(join(REPO_ROOT, 'scripts')),
  ].filter(f => /\.(ts|tsx)$/.test(f))) {
    const relFile = relative(REPO_ROOT, file)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(STRING)) {
      const literal = match[2]!
      // Unescape the `\/` a regex literal uses, so both spellings are seen.
      const probe = literal.replaceAll('\\/', '/')
      if (probe.includes('src/')) continue // apply.ts owns those
      const hit = prefixes.find(p => probe.includes(p))
      if (!hit) continue
      hits.push({ file: relFile, literal, movesTo: dest.get(`src/${hit}`) ?? '' })
    }
  }

  if (hits.length === 0) return 0
  console.log(`\n${hits.length} bare-string path(s) no rewrite can reach:\n`)
  for (const h of hits) {
    console.log(`${h.file}`)
    console.log(`   "${h.literal}"`)
    console.log(`   moves to ${h.movesTo}\n`)
  }
  return hits.length
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
  const bare = reportBareStringPaths(dest)
  process.exitCode = broken.length + bare > 0 ? 1 : 0
}

main()
