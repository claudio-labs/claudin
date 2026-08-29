/**
 * Sizes the candidate filter-floor stages against the recorded Bash corpus.
 *
 * Every number here is a decision input, not a result: the point is to pick a
 * threshold from a table instead of from a guess. Run it before changing
 * `floor.ts`, and again after, so a stage that did not reach the traffic it was
 * sized for is visible rather than absorbed into an aggregate.
 *
 *   bun scripts/bench/tokens/extract-bash-corpus.ts --days 60
 *   bun test scripts/bench/tokens/measure-bash-cap-sizing.test.ts
 *
 * Report, not gate — always passes, skips clean with no corpus. Entries whose
 * recorded text is not the raw output (already filtered, truncated upstream) are
 * excluded: measuring a stage against output a stage already ran on understates
 * it, and there is no way to tell which of the two it was.
 *
 * ## The two questions it answers
 *
 * **Which stages belong in the floor.** `stripAnsi` and `collapseRuns` are safe
 * on output nobody has looked at. `dedupGlobal` is not — it removes non-adjacent
 * duplicate lines, which destroys a table whose column repeats — so it is
 * measured here to price the safety decision rather than to propose shipping it.
 *
 * **Where the destructive cap goes.** A head/tail cap is the only arm with an
 * order of magnitude in it, and the only one that can delete the line that
 * mattered. It is measured across thresholds and head/tail pairs, restricted to
 * output no spec matched, and skipping bodies that look structured — a cut
 * through the middle of a JSON document yields something unparseable, which is
 * worse than sending it whole.
 */
import { test } from 'bun:test'
import { existsSync } from 'fs'
import { applyPipeline } from 'src/tools/shared/outputFilter/Bash/pipeline.js'
import { findFilterForCommand } from 'src/tools/shared/outputFilter/Bash/registry.js'
import { FLOOR_CAP_LINES } from 'src/tools/shared/outputFilter/Bash/floor.js'
import { groupMatchLines } from 'src/tools/shared/outputFilter/Bash/groupMatchLines.js'
import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'
import {
  CORPUS_PATH,
  type CorpusEntry,
  pad,
  padLeft,
  pct,
  readCorpus,
} from './transcriptCorpus.js'

const NEVER_RE = /(?!)/
const spec = (name: string, rest: Partial<FilterSpec>): FilterSpec => ({
  name,
  matchCommand: NEVER_RE,
  ...rest,
})

/** Floor candidates, cheapest-and-safest first. */
const FLOORS: { label: string; spec: FilterSpec }[] = [
  { label: 'stripAnsi', spec: spec('a', { stripAnsi: true }) },
  {
    label: 'stripAnsi + collapseRuns  (shipped)',
    spec: spec('b', { stripAnsi: true, collapseRuns: true }),
  },
  {
    label: '  + collapseDigitTemplates',
    spec: spec('c', {
      stripAnsi: true,
      collapseRuns: true,
      collapseDigitTemplates: true,
    }),
  },
  {
    label: '  + dedupGlobal            (UNSAFE, priced only)',
    spec: spec('d', { stripAnsi: true, collapseRuns: true, dedupGlobal: true }),
  },
]

const THRESHOLDS = [60, 100, 200] as const
/**
 * Cap variants, expressed the way `applyPipeline` actually reads them.
 *
 * A trap worth stating, because the obvious spelling is wrong: setting
 * `maxLines: 200` TOGETHER WITH `headLines`/`tailLines` does NOT cap above 200.
 * Stage 10 fires only when the threshold is exceeded, and its `else if`
 * (`pipeline.ts:748-763`) then applies head/tail to anything longer than
 * `head + tail + 1` — so `{maxLines: 200, headLines: 15, tailLines: 15}` caps
 * above 31 lines and the 200 is inert. The three variants below are therefore
 * `maxLines` ALONE, which takes the 15/15 defaults and honours the threshold.
 * Measuring a wider split against a real threshold is not expressible today.
 */
const CAPS = THRESHOLDS.map(maxLines => ({
  label: `maxLines ${maxLines} (15/15 default)`,
  spec: spec('cap', { maxLines }),
}))
/** The mis-spelling above, priced so the trap is visible rather than described. */
const CAP_TRAP = {
  label: 'maxLines 200 + head/tail 15/15 (caps at 31!)',
  spec: spec('trap', { maxLines: 200, headLines: 15, tailLines: 15 }),
}

/**
 * A body a head/tail cap must not cut: one line has no middle to remove, and a
 * JSON document survives neither half. Deliberately a shape test on the first
 * non-blank character rather than a parse — a 2 MB `JSON.parse` per entry to
 * decide whether to trim it is not a trade worth making.
 */
function isStructured(text: string): boolean {
  const first = text.trimStart()[0]
  if (first === '{' || first === '[') return true
  return text.trimEnd().includes('\n') === false
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

// `groupMatchLines` is measured MARGINALLY, over what the floor and cap already
// took, because a large grep result is exactly the >60-line shape the cap cuts.
// Sizing it standalone double-counts those characters and reads far too high.

function run(entries: CorpusEntry[], s: FilterSpec): { kept: number; raw: number } {
  let kept = 0
  let raw = 0
  for (const e of entries) {
    raw += e.text.length
    kept += applyPipeline(s, e.text, { allowShortCircuit: false }).body.length
  }
  return { kept, raw }
}

test('bash filter floor and cap sizing', () => {
  if (!existsSync(CORPUS_PATH)) {
    console.log(
      `no corpus at ${CORPUS_PATH} — build one with:\n` +
        '  bun scripts/bench/tokens/extract-bash-corpus.ts --days 60',
    )
    return
  }

  const clean = readCorpus().filter(e => !e.alreadyFiltered && !e.truncatedUpstream)
  const totalChars = clean.reduce((n, e) => n + e.text.length, 0)
  console.log(`corpus: ${clean.length} entries with raw output, ${totalChars} chars\n`)

  console.log('floor candidates (all entries, matched or not)')
  console.log(`  ${pad('stages', 48)} ${padLeft('saved', 10)} ${padLeft('%', 7)}`)
  for (const { label, spec: s } of FLOORS) {
    const { kept, raw } = run(clean, s)
    console.log(
      `  ${pad(label, 48)} ${padLeft(String(raw - kept), 10)} ${padLeft(pct(raw - kept, raw), 7)}`,
    )
  }

  // collapseDigitTemplates destroys pretty-printed JSON — `"key_0": 0` through
  // `"key_799": 799` are one template — so the interesting question is what it is
  // worth under the cap's own fence: unmatched commands only, non-structured
  // bodies only. Anything a spec matched keeps whatever its author chose.
  const unmatchedPlain = clean.filter(
    e => findFilterForCommand(e.command) === null && !isStructured(e.text),
  )
  console.log('\ncollapseDigitTemplates, fenced like the cap (unmatched + non-structured)')
  for (const { label, spec: s } of FLOORS.slice(1, 3)) {
    const { kept, raw } = run(unmatchedPlain, s)
    console.log(
      `  ${pad(label, 48)} ${padLeft(String(raw - kept), 10)} ${padLeft(pct(raw - kept, totalChars), 7)} of full corpus`,
    )
  }

  // The cap only applies where no spec matched: a spec's author decided how many
  // lines to keep, and `tsc` omits maxLines because every error line counts.
  const capable = clean.filter(
    e => findFilterForCommand(e.command) === null && !isStructured(e.text),
  )
  const capableChars = capable.reduce((n, e) => n + e.text.length, 0)
  const skippedStructured = clean.filter(
    e => findFilterForCommand(e.command) === null && isStructured(e.text),
  )
  console.log(
    `\ncap-eligible: ${capable.length} entries, ${capableChars} chars ` +
      `(${pct(capableChars, totalChars)} of raw corpus); ` +
      `${skippedStructured.length} skipped as structured`,
  )
  console.log(
    `  ${pad('cap variant', 46)} ${padLeft('entries', 8)} ${padLeft('saved', 10)} ${padLeft('%corpus', 8)} ${padLeft('lines cut', 10)}`,
  )
  for (const { label, spec: s } of [...CAPS, CAP_TRAP]) {
    let kept = 0
    let raw = 0
    let hit = 0
    let linesCut = 0
    for (const e of capable) {
      raw += e.text.length
      const before = lineCount(e.text)
      const body = applyPipeline(s, e.text, { allowShortCircuit: false }).body
      kept += body.length
      if (body !== e.text) {
        hit += 1
        linesCut += before - lineCount(body)
      }
    }
    console.log(
      `  ${pad(label, 46)} ${padLeft(String(hit), 8)} ` +
        `${padLeft(String(raw - kept), 10)} ${padLeft(pct(raw - kept, totalChars), 8)} ${padLeft(String(linesCut), 10)}`,
    )
  }

  // Marginal value of grep grouping, measured after the shipped floor and cap.
  const shipped = spec('shipped', {
    stripAnsi: true,
    collapseRuns: true,
    collapseDigitTemplates: true,
    maxLines: FLOOR_CAP_LINES,
  })
  let afterShipped = 0
  let afterBoth = 0
  let groupedCount = 0
  let rawGrepish = 0
  for (const e of capable) {
    const body = applyPipeline(shipped, e.text, { allowShortCircuit: false }).body
    const grouped = groupMatchLines(body)
    if (grouped === null) continue
    rawGrepish += e.text.length
    afterShipped += body.length
    afterBoth += grouped.length
    groupedCount += 1
  }
  console.log(
    `\ngrep grouping, MARGINAL over the shipped floor+cap:\n` +
      `  ${groupedCount} entries accepted (of ${capable.length} cap-eligible), ` +
      `${rawGrepish} raw → ${afterShipped} after floor+cap → ${afterBoth} with grouping\n` +
      `  extra saving ${afterShipped - afterBoth} chars = ${pct(afterShipped - afterBoth, totalChars)} of the corpus`,
  )
  // Explicit timeout: the work here scales with whatever corpus the developer
  // has on disk (16.7k entries / 14.8M chars at the time of writing, ~5.1s),
  // and the runner's 5s default was close enough to turn a corpus refresh into
  // a red suite. CI has no corpus and returns above, so this only ever binds
  // locally.
}, 60_000)
