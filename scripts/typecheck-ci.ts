/**
 * The typecheck ratchet: fail a PR for the type errors it ADDS, ignore the ones
 * it inherited.
 *
 * `tsc --noEmit` does not come back clean in this repo and is not going to.
 * Roughly two thirds of its output sits in the `src/components/*.tsx` files that
 * are checked in as React-Compiler output, where the transform has already
 * stripped the parameter types and the pre-compiler sources do not exist in this
 * fork. Wiring `bun run typecheck` straight into CI would therefore fail every
 * PR ever opened, which is the same as having no check at all — so the gate is
 * on the DIFF against a committed baseline instead.
 *
 * Identity is `fingerprintDiagnostic`, shared with the Typecheck tool: it hashes
 * file + code + message and deliberately excludes line and column. Without that,
 * adding one import at the top of a file would shift every diagnostic below it
 * and re-report the lot as newly introduced. Comparison is a MULTISET, so three
 * copies of an error the baseline recorded once still count two as new.
 *
 * The message used to be less stable than the line number, and the tool used to
 * report phantom new errors because of it: for a large union tsc expands one
 * arbitrary constituent and truncates the rest, and the pick moves when
 * anything else enters the program. Three real occurrences on 2026-08-07 in
 * `runHeadless.ts` and `matching.characterization.test.ts`, each from a branch
 * that had only ADDED a file. `elideTruncatedUnion` in fingerprint.ts handles
 * it now — see the comment there for why eliding the printed type is not
 * enough. If a phantom does slip through, the triage is unchanged: check the
 * TOTAL count against a clean HEAD before hunting a regression in a file the
 * branch never opened, and `--update` when only hashes moved.
 *
 *   bun run typecheck:ci        check the tree against typecheck-baseline.json
 *   bun run typecheck:baseline  rewrite that file from the current tree
 *
 * Fixing errors never fails the run — it prints how far ahead of the baseline
 * the tree has moved and asks for a refresh, because a ratchet that punishes
 * improvement stops being used.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCheckerOutput } from '../src/tools/TypecheckTool/parseChain.js'
import {
  fingerprintDiagnostic,
  normalizeDiagnosticPath,
  partitionAgainstBaseline,
} from '../src/tools/TypecheckTool/fingerprint.js'
import type { RawDiagnostic } from '../src/tools/shared/diagnostics/types.js'

const CWD = process.cwd()
const BASELINE_PATH = join(CWD, 'typecheck-baseline.json')

/**
 * `--pretty false` is not cosmetic. tsc's pretty output is a multi-line code
 * frame (`file:line:col - error TS…`), and the parser this shares with the
 * Typecheck tool matches the one-line MSVC shape (`file(line,col): error TS…`).
 * Pretty defaults to off when stdout is a pipe, which it is here — but only
 * "usually", and a baseline recorded through the other branch would match
 * nothing.
 */
const TSC_ARGS = ['--noEmit', '--pretty', 'false'] as const

/** Enough of the new errors to act on; the count in the footer is exact. */
const MAX_SHOWN = 40

/**
 * What the checkout path is replaced with before anything is hashed.
 *
 * tsc quotes ABSOLUTE paths inside the message text as well as in the file
 * field — `typeof import("/abs/src/services/compact/snipCompact")`, and the
 * second sentence of every TS7016. The file field is relativised by
 * `normalizeDiagnosticPath`, but the message is hashed verbatim, so 38 of this
 * repo's diagnostics fingerprinted differently under `/home/…/claudin` than
 * under `/home/runner/work/claudin/claudin` and came back as new errors the
 * first time this ran against a fresh clone. `run.ts` hits the same wall with
 * its baseline reconstruction and solves it the same way, at the boundary.
 */
const PROJECT_TOKEN = '<project>'

/**
 * Erase the checkout from raw checker output. Both the logical cwd and its
 * realpath, since a repo reached through a symlink prints one or the other
 * depending on which component tsc resolved.
 */
function eraseProjectPath(text: string): string {
  let out = text.split(CWD).join(PROJECT_TOKEN)
  const real = realpathSync(CWD)
  if (real !== CWD) out = out.split(real).join(PROJECT_TOKEN)
  return out
}

/**
 * A run that reports nothing against a non-empty baseline is far more likely to
 * be a tsc that never executed than a repo that fixed 3000 errors at once, and
 * "0 errors" would sail through the gate. Treated as a failure, never as a pass.
 */
function assertRanPlausibly(count: number, baselineCount: number): void {
  if (count === 0 && baselineCount > 0) {
    console.error(
      `ERROR: tsc reported no diagnostics at all, but the baseline holds ${baselineCount}.\n` +
        `That is a checker that did not run (missing dependencies, wrong cwd), not a clean tree.`,
    )
    process.exit(1)
  }
}

type Baseline = {
  capturedAt: string
  capturedFrom: string
  fingerprints: string[]
}

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Partial<Baseline>
    if (!Array.isArray(parsed.fingerprints)) return null
    return {
      capturedAt: parsed.capturedAt ?? 'unknown',
      capturedFrom: parsed.capturedFrom ?? 'unknown',
      fingerprints: parsed.fingerprints,
    }
  } catch {
    return null
  }
}

/**
 * Hand-rolled rather than `JSON.stringify(…, null, 2)` only for the fingerprint
 * array: one entry per line is what makes `git diff` on a baseline refresh
 * readable as "these N went away, these M arrived" instead of one rewritten blob.
 */
function serializeBaseline(baseline: Baseline): string {
  const fps = baseline.fingerprints
  return [
    '{',
    '  "//": "Generated — do not hand-edit. Refresh with `bun run typecheck:baseline`.",',
    '  "checker": "tsc",',
    `  "command": ${JSON.stringify(['tsc', ...TSC_ARGS].join(' '))},`,
    `  "capturedAt": ${JSON.stringify(baseline.capturedAt)},`,
    `  "capturedFrom": ${JSON.stringify(baseline.capturedFrom)},`,
    `  "count": ${fps.length},`,
    '  "fingerprints": [',
    ...fps.map((fp, i) => `    ${JSON.stringify(fp)}${i === fps.length - 1 ? '' : ','}`),
    '  ]',
    '}',
  ].join('\n')
}

function headSha(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function runTsc(): RawDiagnostic[] {
  const bin = join(CWD, 'node_modules', '.bin', 'tsc')
  if (!existsSync(bin)) {
    console.error(`ERROR: ${bin} not found. Run 'bun install' first.`)
    process.exit(1)
  }

  // FORCE_COLOR is deleted rather than set to "0": anything that tests only for
  // the variable's presence reads "0" as a request to colourise, and an escape
  // sequence in front of a code turns a matching line into an unparsed one.
  const env = { ...process.env, CI: 'true', NO_COLOR: '1' }
  delete env.FORCE_COLOR

  const result = spawnSync(bin, [...TSC_ARGS], {
    cwd: CWD,
    encoding: 'utf8',
    env,
    // A full backlog is several hundred kilobytes; the 1 MB default truncates
    // it, and a truncated run silently drops the diagnostics it never read.
    maxBuffer: 256 * 1024 * 1024,
  })

  if (result.error) {
    console.error(`ERROR: could not run tsc — ${result.error.message}`)
    process.exit(1)
  }

  const parsed = parseCheckerOutput('tsc', {
    stdout: eraseProjectPath(result.stdout ?? ''),
    stderr: eraseProjectPath(result.stderr ?? ''),
    exitCode: result.status ?? 0,
  })

  if (parsed.degraded) {
    console.error(
      'ERROR: tsc output could not be parsed, so nothing can be compared to the baseline.\n' +
        `${(result.stdout ?? '').trim().slice(-2000)}\n${(result.stderr ?? '').trim().slice(-2000)}`,
    )
    process.exit(1)
  }

  const diagnostics = parsed.diagnostics.map(d => ({
    ...d,
    file: normalizeDiagnosticPath(d.file, CWD),
  }))

  // The guard for the failure above, kept because it is invisible otherwise: a
  // fingerprint is a hash, so a baseline recorded with machine-specific text in
  // it looks perfectly well-formed and only misbehaves on someone else's
  // checkout.
  const leaked = diagnostics.filter(d => d.message.includes(CWD) || d.file.includes(CWD))
  if (leaked.length > 0) {
    console.error(
      `ERROR: ${leaked.length} diagnostic(s) still name the checkout path after normalisation, ` +
        `so their fingerprints would not reproduce elsewhere. First one:\n  ${leaked[0]!.message}`,
    )
    process.exit(1)
  }

  return diagnostics
}

const diagnostics = runTsc()
const fingerprints = diagnostics.map(d => fingerprintDiagnostic(d, CWD))

if (process.argv.includes('--update')) {
  const baseline: Baseline = {
    capturedAt: new Date().toISOString().slice(0, 10),
    capturedFrom: headSha(),
    // Sorted so a refresh diffs as insertions and deletions rather than as a
    // reshuffle; duplicates are kept, since the comparison is a multiset.
    fingerprints: [...fingerprints].sort(),
  }
  writeFileSync(BASELINE_PATH, `${serializeBaseline(baseline)}\n`)
  console.log(
    `Wrote typecheck-baseline.json — ${baseline.fingerprints.length} diagnostics at ${baseline.capturedFrom.slice(0, 8)}.`,
  )
  process.exit(0)
}

const baseline = readBaseline()
if (!baseline) {
  console.error(
    'ERROR: typecheck-baseline.json is missing or unreadable.\n' +
      'Record it from a known-good tree with: bun run typecheck:baseline',
  )
  process.exit(1)
}

assertRanPlausibly(diagnostics.length, baseline.fingerprints.length)

const { isNew, fixedCount } = partitionAgainstBaseline(fingerprints, baseline.fingerprints)
const introduced = diagnostics.filter((_, i) => isNew[i])

if (introduced.length === 0) {
  const summary = `${diagnostics.length} pre-existing, baseline ${baseline.fingerprints.length} (${baseline.capturedAt})`
  if (fixedCount > 0) {
    console.log(`✓ no new type errors — and ${fixedCount} fewer than the baseline. (${summary})`)
    console.log('  Refresh it so the ratchet tightens: bun run typecheck:baseline')
  } else {
    console.log(`✓ no new type errors. (${summary})`)
  }
  process.exit(0)
}

console.error(`✗ ${introduced.length} new type error(s) not in typecheck-baseline.json\n`)
for (const d of introduced.slice(0, MAX_SHOWN)) {
  // First line only: tsc folds its "Types of parameters are incompatible" chain
  // into the message, which is worth hashing but not worth printing forty times.
  const [head = ''] = d.message.split('\n')
  console.error(`  ${d.file}:${d.line}  ${d.code ?? 'error'}: ${head}`)
}
if (introduced.length > MAX_SHOWN) {
  console.error(`  … and ${introduced.length - MAX_SHOWN} more`)
}
console.error(
  '\nFix them, or — if they are pre-existing errors this branch merely moved —\n' +
    'refresh the baseline with: bun run typecheck:baseline',
)
process.exit(1)
