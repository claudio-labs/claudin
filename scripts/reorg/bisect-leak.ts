#!/usr/bin/env bun
/**
 * Halving bisect for a cross-file mock leak: finds the smallest prefix of the
 * suite that, run before the victim, reproduces its failure.
 *
 *   bun scripts/reorg/bisect-leak.ts <victim.test.ts> <substring of failing test name>
 */
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const [victim, needle] = process.argv.slice(2)
if (!victim || !needle) throw new Error('usage: bisect-leak.ts <victim> <needle>')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.test\.tsx?$/.test(entry)) out.push(full.slice(REPO_ROOT.length + 1))
  }
  return out
}

const all = walk(join(REPO_ROOT, 'src')).filter(f => f !== victim)

function reproduces(files: string[]): boolean {
  const res = Bun.spawnSync(['bun', 'test', ...files, victim], { cwd: REPO_ROOT })
  const out = res.stdout.toString() + res.stderr.toString()
  return out.split('\n').some(l => l.startsWith('(fail)') && l.includes(needle))
}

if (!reproduces(all)) {
  console.log('does not reproduce with the whole suite — nothing to bisect')
  process.exit(0)
}

let candidates = all
while (candidates.length > 1) {
  const half = Math.ceil(candidates.length / 2)
  const left = candidates.slice(0, half)
  const right = candidates.slice(half)
  if (reproduces(left)) candidates = left
  else if (reproduces(right)) candidates = right
  else {
    // The leak needs files from BOTH halves; keep the left half pinned and
    // narrow the right one against it.
    let tail = right
    while (tail.length > 1) {
      const cut = Math.ceil(tail.length / 2)
      if (reproduces([...left, ...tail.slice(0, cut)])) tail = tail.slice(0, cut)
      else if (reproduces([...left, ...tail.slice(cut)])) tail = tail.slice(cut)
      else break
    }
    console.log('needs both halves; right-side narrowed to:')
    for (const f of tail) console.log(`  ${f}`)
    process.exit(0)
  }
  console.log(`narrowed to ${candidates.length}`)
}

console.log(`culprit: ${candidates[0]}`)
