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
// `oldPath` may carry a line range — `path@91-4233` — to compare only the
// region that actually moved, leaving a header behind.
//
// A newPath prefixed `delta:` is differenced against <ref> first, so only the
// lines the split ADDED to an already-populated sibling count. Without it an
// append target drags its whole pre-existing body into the comparison and the
// check cannot answer the only question worth asking: did any moved line get
// lost or altered on the way out.
//
// Deleted with the rest of the split scaffolding.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [, , ref, oldPath, ...newPaths] = process.argv
if (!ref || !oldPath || newPaths.length === 0) {
  console.error(
    'usage: verify-relocation.ts <ref> <oldPath>[@start-end] <[delta:]newPath...>',
  )
  process.exit(2)
}

// `\b` after `import` also matches `import.meta.dir` on its own line — the
// second line of a wrapped `resolve(import.meta.dir, …)`. That looked like the
// head of a multi-line import, so the scan below swallowed everything up to the
// next `from '…'` in the file: a 4233-line test stripped down to 17 lines and
// the check reported thousands of phantom deltas. Require the space.
const IMPORT_START = /^\s*import\s/
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

function tally(lines: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

function atRef(path: string): string {
  return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' })
}

const RANGE_RE = /^(.*)@(\d+)-(\d+)$/
const m = RANGE_RE.exec(oldPath)
const oldFile = m?.[1] ?? oldPath
const oldText = atRef(oldFile)
const before = strip(
  m
    ? oldText
        .split('\n')
        .slice(Number(m[2]) - 1, Number(m[3]))
        .join('\n')
    : oldText,
)

/** Lines this split added to `path`, as a multiset: what is on disk now minus
 *  what was already there at <ref>. */
function addedLines(path: string): string[] {
  const was = tally(strip(atRef(path)))
  const out: string[] = []
  for (const line of strip(readFileSync(path, 'utf8'))) {
    const left = was.get(line) ?? 0
    if (left > 0) was.set(line, left - 1)
    else out.push(line)
  }
  return out
}

const after: string[] = []
for (const p of newPaths) {
  if (p.startsWith('delta:')) after.push(...addedLines(p.slice('delta:'.length)))
  else after.push(...strip(readFileSync(p, 'utf8')))
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
