/**
 * The dead-code ratchet: fail a PR for the unused exports it ADDS, ignore the
 * ones it inherited.
 *
 * `deadcode:ci` has never checked a single export. It runs
 * `knip --include files,dependencies,devDependencies`, and `--include` is an
 * ALLOWLIST — so the export and type dimensions were simply absent from CI,
 * which is how ~1300 unused exports could accumulate while the gate stayed
 * green. Turning them on directly is not an option either: the starting number
 * is four figures, and a check that fails every PR from the first day is the
 * same as no check at all. Hence the ratchet, modelled on
 * `scripts/verify/typecheck-ci.ts` and sharing its multiset comparison.
 *
 * Identity is `<kind> <file>#<name>`, with line, column and byte offset
 * deliberately excluded: adding an import at the top of a file moves every
 * declaration below it, and a positional identity would re-report the lot as
 * newly introduced on the next run. Entries are stored in full rather than
 * hashed — unlike a tsc message, an export identity carries no machine-specific
 * text, and a baseline you can read is what makes a refresh diff say "these
 * became used, those became unused" instead of showing a wall of moved hashes.
 *
 * Comparison is a MULTISET, so two exports of the same name in one file where
 * the baseline recorded one still count one as new.
 *
 * All of knip's issue kinds are ratcheted, not just exports. `files`,
 * `dependencies` and `devDependencies` sit at zero today, so for them an empty
 * baseline gives hard-gate behaviour for free — the same thing `deadcode:ci`
 * enforces, without a second invocation having to be the thing that enforces it.
 *
 *   bun run deadcode:exports    check the tree against knip-baseline.json
 *   bun run deadcode:baseline   rewrite that file from the current tree
 *
 * Fixing findings never fails the run — it prints how far ahead of the baseline
 * the tree has moved and asks for a refresh, because a ratchet that punishes
 * improvement stops being used.
 *
 * Before believing any single entry, apply the three guards from
 * `.claudin/memory/team/knip-unused-export-is-not-unused.md`: knip's "unused
 * export" means only that nothing IMPORTS it, the declaring module usually uses
 * its own export, and a code generator reading a file as TEXT is invisible here.
 *
 * Two baselined entries are known FALSE and cannot be removed from the file —
 * it is generated, so deleting a line knip still reports would make the next run
 * call it newly introduced:
 *
 *   exports src/agent/coordinator/teammate.ts#setDynamicTeamContext
 *   exports src/agent/coordinator/teammateMailbox.ts#formatTeammateMessages
 *
 * Both are live, reached through a `require()` namespace followed by member
 * access (`getTeammateUtils().setDynamicTeamContext` at
 * platform/main/action/parseOptions.ts, `getTeammateMailbox()` at
 * agent/messages/attachments.ts) — a shape knip does not trace. Do not "clean
 * them up" on the strength of this baseline.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { partitionAgainstBaseline } from '../../src/tools/TypecheckTool/fingerprint.js'

const CWD = process.cwd()
const BASELINE_PATH = join(CWD, 'knip-baseline.json')

/**
 * Must stay identical between the check and the capture: a baseline recorded
 * under a different `--include` set matches nothing, and every entry missing
 * from it reads as newly introduced.
 */
const KNIP_ARGS = [
  '--include',
  'files,dependencies,devDependencies,exports,types',
  '--reporter',
  'json',
  '--no-config-hints',
] as const

/** Enough of the new findings to act on; the count in the footer is exact. */
const MAX_SHOWN = 40

/**
 * The per-file shape of knip's JSON reporter. Every key but `file` is an array,
 * and the ones naming a symbol carry `{name, line, col, pos}` — of which only
 * `name` takes part in identity.
 */
type KnipIssueFile = {
  file: string
  [kind: string]: string | Array<{ name: string }> | undefined
}

type Finding = { kind: string; file: string; name: string }

function toEntry(f: Finding): string {
  return `${f.kind} ${f.file}#${f.name}`
}

type Baseline = {
  capturedAt: string
  capturedFrom: string
  entries: string[]
}

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Partial<Baseline>
    if (!Array.isArray(parsed.entries)) return null
    return {
      capturedAt: parsed.capturedAt ?? 'unknown',
      capturedFrom: parsed.capturedFrom ?? 'unknown',
      entries: parsed.entries,
    }
  } catch {
    return null
  }
}

/**
 * One entry per line, so `git diff` on a refresh reads as insertions and
 * deletions rather than as one rewritten blob.
 */
function serializeBaseline(baseline: Baseline): string {
  const entries = baseline.entries
  return [
    '{',
    '  "//": "Generated — do not hand-edit. Refresh with `bun run deadcode:baseline`.",',
    '  "tool": "knip",',
    `  "command": ${JSON.stringify(['knip', ...KNIP_ARGS].join(' '))},`,
    `  "capturedAt": ${JSON.stringify(baseline.capturedAt)},`,
    `  "capturedFrom": ${JSON.stringify(baseline.capturedFrom)},`,
    `  "count": ${entries.length},`,
    '  "entries": [',
    ...entries.map((e, i) => `    ${JSON.stringify(e)}${i === entries.length - 1 ? '' : ','}`),
    '  ]',
    '}',
  ].join('\n')
}

function headSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function runKnip(): Finding[] {
  const bin = join(CWD, 'node_modules', '.bin', 'knip')
  if (!existsSync(bin)) {
    console.error(`ERROR: ${bin} not found. Run 'bun install' first.`)
    process.exit(1)
  }

  // FORCE_COLOR is deleted rather than set to "0": anything that tests only for
  // the variable's presence reads "0" as a request to colourise, and an escape
  // sequence inside the JSON makes it unparseable.
  const env = { ...process.env, CI: 'true', NO_COLOR: '1' }
  delete env.FORCE_COLOR

  const result = spawnSync(bin, [...KNIP_ARGS], {
    cwd: CWD,
    encoding: 'utf8',
    env,
    // Four figures of findings is several hundred kilobytes of JSON; the 1 MB
    // default truncates it, and truncated JSON does not parse at all — which at
    // least fails loudly rather than silently dropping entries.
    maxBuffer: 256 * 1024 * 1024,
  })

  if (result.error) {
    console.error(`ERROR: could not run knip — ${result.error.message}`)
    process.exit(1)
  }

  // knip exits 1 when it has findings and 0 when clean, so the exit code says
  // nothing about whether it RAN. The JSON is what says that.
  let parsed: { issues?: KnipIssueFile[] }
  try {
    parsed = JSON.parse(result.stdout ?? '') as { issues?: KnipIssueFile[] }
  } catch {
    console.error(
      'ERROR: knip did not produce parseable JSON, so nothing can be compared to the baseline.\n' +
        `${(result.stdout ?? '').trim().slice(-2000)}\n${(result.stderr ?? '').trim().slice(-2000)}`,
    )
    process.exit(1)
  }

  if (!Array.isArray(parsed.issues)) {
    console.error('ERROR: knip JSON has no `issues` array — the reporter shape changed.')
    process.exit(1)
  }

  const findings: Finding[] = []
  for (const entry of parsed.issues) {
    const file = entry.file
    if (typeof file !== 'string') continue
    for (const [kind, value] of Object.entries(entry)) {
      if (kind === 'file' || !Array.isArray(value)) continue
      for (const item of value) {
        if (item && typeof item.name === 'string') {
          findings.push({ kind, file, name: item.name })
        }
      }
    }
  }
  return findings
}

/**
 * A run that reports nothing against a four-figure baseline is far more likely
 * to be a knip that analysed zero files than a branch that cleaned up 1300
 * exports at once — and "0 findings" would sail through the gate. This is not
 * hypothetical here: `knip --production` does exactly that when the entry
 * patterns lack their `!` suffixes, reporting an empty analysis as a clean one.
 */
function assertRanPlausibly(count: number, baselineCount: number): void {
  if (count === 0 && baselineCount > 0) {
    console.error(
      `ERROR: knip reported no findings at all, but the baseline holds ${baselineCount}.\n` +
        `That is an analysis that never ran (missing dependencies, wrong cwd, or a config\n` +
        `whose patterns negated every project file), not a clean tree.`,
    )
    process.exit(1)
  }
}

const findings = runKnip()
const entries = findings.map(toEntry)

if (process.argv.includes('--update')) {
  const baseline: Baseline = {
    capturedAt: new Date().toISOString().slice(0, 10),
    capturedFrom: headSha(),
    // Sorted so a refresh diffs as insertions and deletions rather than as a
    // reshuffle; duplicates are kept, since the comparison is a multiset.
    entries: [...entries].sort(),
  }
  writeFileSync(BASELINE_PATH, `${serializeBaseline(baseline)}\n`)
  console.log(
    `Wrote knip-baseline.json — ${baseline.entries.length} findings at ${baseline.capturedFrom.slice(0, 8)}.`,
  )
  process.exit(0)
}

const baseline = readBaseline()
if (!baseline) {
  console.error(
    'ERROR: knip-baseline.json is missing or unreadable.\n' +
      'Record it from a known-good tree with: bun run deadcode:baseline',
  )
  process.exit(1)
}

assertRanPlausibly(findings.length, baseline.entries.length)

const { isNew, fixedCount } = partitionAgainstBaseline(entries, baseline.entries)
const introduced = findings.filter((_, i) => isNew[i])

if (introduced.length === 0) {
  const summary = `${findings.length} pre-existing, baseline ${baseline.entries.length} (${baseline.capturedAt})`
  if (fixedCount > 0) {
    console.log(`✓ no new dead code — and ${fixedCount} fewer than the baseline. (${summary})`)
    console.log('  Refresh it so the ratchet tightens: bun run deadcode:baseline')
  } else {
    console.log(`✓ no new dead code. (${summary})`)
  }
  process.exit(0)
}

console.error(`✗ ${introduced.length} new dead-code finding(s) not in knip-baseline.json\n`)
for (const f of introduced.slice(0, MAX_SHOWN)) {
  console.error(`  ${f.file}  ${f.kind}: ${f.name}`)
}
if (introduced.length > MAX_SHOWN) {
  console.error(`  … and ${introduced.length - MAX_SHOWN} more`)
}
console.error(
  '\nRemove them, or — if they are pre-existing findings this branch merely moved —\n' +
    'refresh the baseline with: bun run deadcode:baseline',
)
process.exit(1)
