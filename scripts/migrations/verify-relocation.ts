// Mechanical proof that a file split was a pure relocation.
//
// Strips import statements (and the `export` keyword, since a symbol that was
// private often becomes exported when it moves) from the pre-split file and
// from the concatenated siblings, then compares the two line multisets. A
// correct relocation shows an empty diff; anything reported is a real delta
// and has to be explained before the commit lands.
//
// Usage:
//   bun run scripts/migrations/verify-relocation.ts <ref> <oldPath> <newPath...>
//
// Deleted with the rest of the split scaffolding.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [, , ref, oldPath, ...newPaths] = process.argv
if (!ref || !oldPath || newPaths.length === 0) {
  console.error(
    'usage: verify-relocation.ts <ref> <oldPath> <newPath...>',
  )
  process.exit(2)
}

const IMPORT_START = /^\s*import\b/
const IMPORT_END = /\bfrom\s*['"]/
const EXPORT_KEYWORD = /^(\s*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var|type|interface|enum|abstract)\b)/
const REEXPORT_START = /^\s*export\s*\{/

/** Drop import statements and re-export blocks; normalize away the `export`
 *  keyword so a symbol that became exported on the way out still matches. */
function strip(source: string): string[] {
  const out: string[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (IMPORT_START.test(line) || REEXPORT_START.test(line)) {
      // Single-line form already carries its `from '...'`.
      if (IMPORT_END.test(line) || /^\s*export\s*\{[^}]*\}\s*$/.test(line)) {
        if (!IMPORT_END.test(line)) {
          // `export { a, b }` with no `from` — a local re-export block.
          continue
        }
        continue
      }
      // Multi-line form: consume through the closing `} from '...'`.
      while (i < lines.length && !IMPORT_END.test(lines[i] ?? '')) i++
      continue
    }
    const trimmed = line.replace(EXPORT_KEYWORD, '$1')
    if (trimmed.trim() === '') continue
    out.push(trimmed)
  }
  return out
}

const before = strip(
  execFileSync('git', ['show', `${ref}:${oldPath}`], { encoding: 'utf8' }),
)
const after = strip(
  newPaths.map(p => readFileSync(p, 'utf8')).join('\n'),
)

function tally(lines: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

const a = tally(before)
const b = tally(after)
const keys = new Set([...a.keys(), ...b.keys()])

const onlyBefore: string[] = []
const onlyAfter: string[] = []
for (const k of keys) {
  const d = (b.get(k) ?? 0) - (a.get(k) ?? 0)
  for (let i = 0; i < -d; i++) onlyBefore.push(k)
  for (let i = 0; i < d; i++) onlyAfter.push(k)
}

console.log(`before: ${before.length} lines   after: ${after.length} lines`)
if (onlyBefore.length === 0 && onlyAfter.length === 0) {
  console.log('✓ pure relocation — line multisets identical')
  process.exit(0)
}
for (const l of onlyBefore) console.log(`- ${l}`)
for (const l of onlyAfter) console.log(`+ ${l}`)
console.log(`\n✗ ${onlyBefore.length} lost, ${onlyAfter.length} added`)
process.exit(1)
