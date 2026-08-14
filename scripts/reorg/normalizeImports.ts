#!/usr/bin/env bun
/**
 * Rewrites every parent-traversing module specifier (`'../…'`) under `src/` to
 * the `src/…` tsconfig alias (tsconfig.json `paths`), leaving same-directory
 * `'./sibling.js'` specifiers alone.
 *
 * Why this exists: `scripts/build.ts` pre-scans `src/` and replaces any
 * *relative* `.js` specifier that fails to resolve with a `missing-module-stub`
 * that exports `() => null` — silently, with no warning. Aliased specifiers get
 * no such treatment: they reach Bun's resolver and fail the build outright.
 * Normalizing to the alias therefore converts a silent failure class into a loud
 * one, which is what makes a large file move verifiable at all.
 *
 * Contexts rewritten: `from '…'`, side-effect `import '…'`, dynamic `import('…')`,
 * `require('…')` and `mock.module('…')` — each tolerant of newlines, because
 * `src/query.ts` and friends break the specifier onto its own line.
 *
 * Deliberately NOT rewritten, and reported instead:
 *  - specifiers that do not resolve to a file on disk (those are pre-existing
 *    dead imports; aliasing them would turn a silent noop into a build failure,
 *    which is a real fix but not one to make blindly in a rename-only pass)
 *  - template-literal specifiers, which are computed and need a human
 *  - specifiers that escape `src/`
 *
 * Usage:
 *   bun scripts/reorg/normalizeImports.ts --dry     # report only
 *   bun scripts/reorg/normalizeImports.ts           # rewrite in place
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')
const DRY = process.argv.includes('--dry')

/** `from '…'`, `import '…'`, `import('…')`, `require('…')`, `mock.module('…')`. */
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bfrom\s*(['"])(\.\.\/[^'"]*)\1/g,
  /\bimport\s*(['"])(\.\.\/[^'"]*)\1/g,
  /\bimport\s*\(\s*(['"])(\.\.\/[^'"]*)\1/g,
  /\brequire\s*\(\s*(['"])(\.\.\/[^'"]*)\1/g,
  /\bmock\.module\s*\(\s*(['"])(\.\.\/[^'"]*)\1/g,
]

/** Any backtick specifier that traverses upward — computed, so a human decides. */
const TEMPLATE_PATTERN = /\b(?:import|require)\s*\(\s*`([^`]*\.\.[^`]*)`/g

type Report = {
  rewritten: number
  filesTouched: string[]
  unresolved: string[]
  templates: string[]
  escaped: string[]
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

/**
 * A `.js` specifier in this repo names a `.ts`/`.tsx` file on disk, and a
 * directory specifier names its `index.*`. Returns true when any candidate
 * exists — i.e. when aliasing the specifier is safe.
 */
function resolvesOnDisk(absNoExt: string): boolean {
  const stripped = absNoExt.replace(/\.(js|jsx|ts|tsx)$/, '')
  const candidates = [
    absNoExt,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.js`,
    `${stripped}.json`,
    join(absNoExt, 'index.ts'),
    join(absNoExt, 'index.tsx'),
    join(absNoExt, 'index.js'),
  ]
  return candidates.some(c => existsSync(c))
}

function normalizeFile(file: string, report: Report): void {
  const original = readFileSync(file, 'utf8')
  let next = original

  for (const pattern of SPECIFIER_PATTERNS) {
    next = next.replace(pattern, (match, quote: string, specifier: string) => {
      const abs = resolve(dirname(file), specifier)
      const rel = relative(REPO_ROOT, abs)

      if (!rel.startsWith('src/')) {
        report.escaped.push(`${relative(REPO_ROOT, file)} → ${specifier}`)
        return match
      }
      if (!resolvesOnDisk(abs)) {
        report.unresolved.push(`${relative(REPO_ROOT, file)} → ${specifier}`)
        return match
      }

      report.rewritten++
      return match.replace(`${quote}${specifier}${quote}`, `${quote}${rel}${quote}`)
    })
  }

  for (const match of original.matchAll(TEMPLATE_PATTERN)) {
    report.templates.push(`${relative(REPO_ROOT, file)} → \`${match[1]}\``)
  }

  if (next !== original) {
    report.filesTouched.push(relative(REPO_ROOT, file))
    if (!DRY) writeFileSync(file, next)
  }
}

function main(): void {
  const report: Report = {
    rewritten: 0,
    filesTouched: [],
    unresolved: [],
    templates: [],
    escaped: [],
  }

  for (const file of walk(SRC_ROOT)) normalizeFile(file, report)

  const label = DRY ? 'would rewrite' : 'rewrote'
  console.log(`${label} ${report.rewritten} specifiers across ${report.filesTouched.length} files`)

  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return
    console.log(`\n${title} (${lines.length}):`)
    for (const line of [...new Set(lines)].sort()) console.log(`  ${line}`)
  }

  section('LEFT RELATIVE — does not resolve on disk (currently stubbed to noop)', report.unresolved)
  section('LEFT RELATIVE — escapes src/', report.escaped)
  section('NEEDS A HUMAN — computed template specifier', report.templates)
}

main()
