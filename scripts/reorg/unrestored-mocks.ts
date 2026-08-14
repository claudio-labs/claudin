#!/usr/bin/env bun
/**
 * Lists module-scope `mock.module()` registrations that are never put back.
 *
 * mock.restore() does not revert mock.module, and the registry is process-wide
 * for the whole `bun test` run, so an unrestored stub at column 0 answers for
 * every other file too. That is invisible until a file moves and starts
 * resolving to the same specifier — which is exactly what this reorg did.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const only = process.argv[2]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

for (const file of walk(join(REPO_ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  // Column-0 registrations only: anything indented is inside a hook or a test.
  const topLevel = new Set<string>()
  for (const line of lines) {
    const match = /^mock\.module\(\s*['"]([^'"]+)['"]/.exec(line)
    if (match) topLevel.add(match[1]!)
  }
  if (topLevel.size === 0) continue

  // A restore is any indented re-registration of the same specifier.
  const restored = new Set<string>()
  for (const line of lines) {
    const match = /^\s+mock\.module\(\s*['"]([^'"]+)['"]/.exec(line)
    if (match) restored.add(match[1]!)
  }

  const leaked = [...topLevel].filter(s => !restored.has(s))
  if (only && !leaked.some(s => s.includes(only))) continue
  if (leaked.length === 0) continue

  console.log(`\n${file.slice(REPO_ROOT.length + 1)}`)
  for (const specifier of leaked) console.log(`  ${specifier}`)
}
