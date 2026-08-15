// One-shot codemod: applies scripts/env-rename-map.json to the tree.
//
// This is the CLAUDE_* -> CLAUDIN_* cut-over. It is committed rather than run
// and thrown away so the next person can see exactly which names moved and,
// more importantly, which ones deliberately did NOT (buckets C and D in the
// map — an inbound contract that something outside this process sets, and the
// dead-in-this-fork names whose code a later round removes).
//
// Two rules make this safe to run over 380+ files:
//
//   1. It is driven off the map's `from` fields, never off a `CLAUDE_*`
//      pattern. 67 `CLAUDE_*`-shaped TypeScript constants (CLAUDE_AI_BASE_URL,
//      CLAUDE_ALIAS_REGEX, CLAUDE_3_5_HAIKU_CONFIG, …) are not env vars at all
//      and a pattern-driven pass would rename them.
//   2. Matching is whole-word. `_` is a word character, so \bCLAUDE_CODE_SIMPLE\b
//      cannot fire inside a longer CLAUDE_CODE_SIMPLE_X, and a rule for a short
//      name cannot clip a longer one.
//
// Unlike a symbol rename, occurrences inside STRINGS and COMMENTS are in scope
// and wanted: the two name-indexed lists in managedEnvConstants.ts, the --bare
// help text, and the `${...SKILL_DIR}` placeholders are all string data.
//
// Run: bun scripts/apply-env-rename.ts [--dry]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

type RenameEntry = { from: string; to: string; bucket: string }
type Map_ = {
  rename: RenameEntry[]
  writeOnlyOutbound: RenameEntry[]
  keep: { name: string; bucket: string }[]
}

const ROOT = join(import.meta.dir, '..')
const map = JSON.parse(
  readFileSync(join(ROOT, 'scripts/env-rename-map.json'), 'utf-8'),
) as Map_
const dryRun = process.argv.includes('--dry')

// The dynamic prefix is not a name — runners.ts builds the plugin-option var
// at runtime from the plugin's option keys, so it needs a prefix rule with no
// trailing boundary. Kept out of the exact-name list on purpose.
//
// Both halves are assembled from fragments so this file cannot rewrite its own
// rules when it walks scripts/. That is not paranoia: the first run did exactly
// that, collapsing the pair into CLAUDIN_ -> CLAUDIN_ and silently disarming
// the rule for any re-run. SELF is excluded from the file list for the same
// reason, so the codemod is idempotent.
const OLD = 'CLAUDE' + '_PLUGIN_OPTION_'
const NEW = 'CLAUDIN' + '_PLUGIN_OPTION_'
const PREFIX_RULES: Array<[string, string]> = [[OLD, NEW]]
const SELF = 'apply-env-rename.ts'

const exact: Array<[string, string]> = [
  ...map.rename.map(e => [e.from, e.to] as [string, string]),
  ...map.writeOnlyOutbound
    .filter(e => !e.from.includes('<'))
    .map(e => [e.from, e.to] as [string, string]),
]

// Guard the invariant the whole cut-over rests on: nothing we rename may also
// appear in the keep list, and no two sources may collide on one target.
const keepNames = new Set(map.keep.map(k => k.name))
const targets = new Set<string>()
for (const [from, to] of exact) {
  if (keepNames.has(from)) throw new Error(`${from} is in both rename and keep`)
  if (targets.has(to)) throw new Error(`two sources collide on ${to}`)
  targets.add(to)
}

// Longest first so a prefix rule can never pre-empt a longer exact name.
exact.sort((a, b) => b[0].length - a[0].length)

const CODE_DIRS = ['src', 'scripts']
const CODE_EXT = /\.(ts|tsx)$/
// Docs the cut-over invalidates: .env.example lists the knobs by name, the
// rules describe live procedure. .claudin/memory/ is deliberately excluded —
// those record what was true when they were written and are the user's to curate.
const DOC_DIRS = ['docs', '.claudin/rules', '.claudin/skills']
const DOC_FILES = ['.env.example']
const DOC_EXT = /\.(md|example|json|ya?ml)$/

function walk(dir: string, ext: RegExp, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      walk(full, ext, out)
    } else if (ext.test(e.name) && e.name !== SELF) {
      out.push(full)
    }
  }
}

const files: string[] = []
for (const d of CODE_DIRS) walk(join(ROOT, d), CODE_EXT, files)
for (const d of DOC_DIRS) walk(join(ROOT, d), DOC_EXT, files)
for (const f of DOC_FILES) {
  const p = join(ROOT, f)
  try {
    if (statSync(p).isFile()) files.push(p)
  } catch {
    /* absent is fine */
  }
}

const perName = new Map<string, number>()
let filesChanged = 0
let totalReplacements = 0

for (const file of files) {
  const raw = readFileSync(file, 'utf-8')
  // Cheap reject: the overwhelming majority of files hold no CLAUDE_ token.
  if (!raw.includes('CLAUDE_')) continue

  let out = raw
  for (const [from, to] of exact) {
    const re = new RegExp(`\\b${from}\\b`, 'g')
    const hits = out.match(re)
    if (!hits) continue
    out = out.replace(re, to)
    perName.set(from, (perName.get(from) ?? 0) + hits.length)
    totalReplacements += hits.length
  }
  for (const [from, to] of PREFIX_RULES) {
    const re = new RegExp(`\\b${from}`, 'g')
    const hits = out.match(re)
    if (!hits) continue
    out = out.replace(re, to)
    perName.set(from, (perName.get(from) ?? 0) + hits.length)
    totalReplacements += hits.length
  }

  if (out !== raw) {
    filesChanged++
    if (!dryRun) writeFileSync(file, out)
  }
}

const unused = exact.filter(([from]) => !perName.has(from)).map(([from]) => from)

console.log(`${dryRun ? '[dry] ' : ''}scanned ${files.length} files`)
console.log(`  files changed:      ${filesChanged}`)
console.log(`  replacements:       ${totalReplacements}`)
console.log(`  names applied:      ${perName.size} of ${exact.length + PREFIX_RULES.length}`)
if (unused.length) {
  console.log(`  names with 0 hits:  ${unused.length}`)
  for (const n of unused) console.log(`      ${n}`)
}
