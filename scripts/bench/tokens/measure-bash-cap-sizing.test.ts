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
 *
 * **What one cut should look like** (second test, plan `perf/bash-read-lane`).
 * Today two cutters take turns on Bash output — the floor cap past 60 lines,
 * and the tool-result summarizer on what the floor left unwrapped past 8k
 * chars — and the read lane (`readLane.ts`) exempts the model's own reads from
 * both. That test prices today's pair against a single floor cut across
 * triggers and head/tail pairs, and what the lane gives back.
 */
import { test } from 'bun:test'
import { existsSync } from 'fs'
import { summarizeBashOutput } from 'src/agent/tools/toolResultSummarizer/bash.js'
import { BASH_SUMMARIZE_THRESHOLD } from 'src/agent/tools/toolResultSummarizer/thresholds.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { applyPipeline } from 'src/tools/shared/outputFilter/Bash/pipeline.js'
import { findFilterForCommand } from 'src/tools/shared/outputFilter/Bash/registry.js'
import {
  BOUNDED_READ_MAX_LINES,
  FLOOR_CAP_LINES,
  GENERIC_FLOOR,
  isCappableBody,
  isPathLine,
  looksLikeDiagnostics,
  looksLikeLocationList,
  MAX_KEPT_PATH_LINES,
} from 'src/tools/shared/outputFilter/Bash/floor.js'
import { errorWindowMask } from 'src/tools/shared/outputFilter/Bash/cutShape.js'
import { groupMatchLines } from 'src/tools/shared/outputFilter/Bash/groupMatchLines.js'
import { FILE_READ_PASSTHROUGH_MAX_CHARS } from 'src/tools/shared/outputFilter/Bash/index.js'
import { commandLineBound } from 'src/tools/shared/outputFilter/Bash/lineBound.js'
import { isModelDirectedRead } from 'src/tools/shared/outputFilter/Bash/readLane.js'
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
/** The shipped cap with CLAUDIN_CAP_KEEP_PATHS: what keeping the path lines gives back. */
const CAP_KEEP_PATHS = {
  label: `maxLines ${FLOOR_CAP_LINES} + keep path lines`,
  spec: spec('keep', {
    maxLines: FLOOR_CAP_LINES,
    keepLines: { test: isPathLine, max: MAX_KEPT_PATH_LINES },
  }),
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
  for (const { label, spec: s } of [...CAPS, CAP_TRAP, CAP_KEEP_PATHS]) {
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

// ---------------------------------------------------------------------------
// One cut: today's two cutters against a single floor cut
// ---------------------------------------------------------------------------

/**
 * What the replay needs to know about one result: the text the cut would see,
 * how long it was before any cutter ran, and what came out.
 *
 * "Removed" counts the CUT alone — the lossless stages (`stripAnsi`,
 * `collapseRuns`, the fenced digit collapse, grep grouping) run in every arm
 * and are subtracted, so a row is not credited with savings the floor makes
 * whatever the cut is.
 */
type Outcome = { by: 'cap' | 'summarizer' | 'one-cut' | null; before: number; after: number; keptLines: number }

const ONE_CUT_TRIGGERS = [60, 100, 150] as const
const ONE_CUT_KEEPS = [
  { head: 15, tail: 15 },
  { head: 40, tail: 60 },
  { head: 60, tail: 60 },
] as const

/** A `<bash-output-read>` body was left whole on purpose; its inside is the raw output. */
const READ_WRAPPER_RE = /^<bash-output-read>\n?([\s\S]*?)\n?<\/bash-output-read>\s*$/

function unwrapRead(text: string): string {
  return READ_WRAPPER_RE.exec(text)?.[1] ?? text
}

/**
 * The floor's spec for this body, exactly as `floorOptionsFor` (`index.ts`)
 * decides it — minus the cap, which each arm adds its own way. `diagnostics`
 * and `eligible` are passed in because the caller already computed them.
 */
function losslessFloor(eligible: boolean, diagnostics: boolean, text: string): FilterSpec {
  if (!eligible) return GENERIC_FLOOR
  return {
    ...GENERIC_FLOOR,
    renderBody: groupMatchLines,
    ...(!diagnostics && !looksLikeLocationList(text) ? { collapseDigitTemplates: true } : {}),
  }
}

/**
 * `isWithinCommandBound` (`index.ts`), on by default since #252: a read whose
 * command bounds its own output within 150 lines comes back whole in every
 * arm, so neither today nor a candidate is credited with cutting it.
 */
function isBoundedRead(command: string, text: string): boolean {
  if (text.length > FILE_READ_PASSTHROUGH_MAX_CHARS) return false
  if (text.split('\n').length <= FLOOR_CAP_LINES) return false
  if (text.trimEnd().split('\n').length > BOUNDED_READ_MAX_LINES) return false
  const bound = commandLineBound(command)
  return bound !== null && bound <= BOUNDED_READ_MAX_LINES
}

/**
 * Today's summarizer arm on a result the floor left unwrapped: past 8k chars,
 * 40 head + 60 tail + error windows (`summarizeBashOutput`), dropped when it
 * saves nothing. The code-outline and JSON strategies that run ahead of it in
 * the bundle are left out — the plan replaces the head/tail arm only.
 */
function summarized(text: string): Outcome {
  const uncut: Outcome = { by: null, before: text.length, after: text.length, keptLines: lineCount(text) }
  if (text.length < BASH_SUMMARIZE_THRESHOLD) return uncut
  const s = summarizeBashOutput(text)
  if (s === null || s.body.length >= text.length) return uncut
  return { by: 'summarizer', before: text.length, after: s.body.length, keptLines: lineCount(s.body) }
}

/**
 * Today: the floor with the 60-line cap (15+15, path lines spared); whatever
 * it wrapped — cut or not — the summarizer stands aside for
 * (`isAlreadyCompacted`), and what it left as printed goes to the summarizer.
 */
function today(command: string, text: string): Outcome {
  const eligible = isCappableBody(text)
  const diagnostics = eligible && looksLikeDiagnostics(text)
  const cap = eligible && !diagnostics
  if (cap && isBoundedRead(command, text)) {
    return { by: null, before: text.length, after: text.length, keptLines: lineCount(text) }
  }
  const floor = losslessFloor(eligible, diagnostics, text)
  const before = applyPipeline(floor, text, { allowShortCircuit: false }).body.length
  const result = applyPipeline(
    cap ? { ...floor, maxLines: FLOOR_CAP_LINES, keepLines: { test: isPathLine, max: MAX_KEPT_PATH_LINES } } : floor,
    text,
    { allowShortCircuit: false },
  )
  if (result.applied.includes('maxLines')) {
    return { by: 'cap', before, after: result.body.length, keptLines: lineCount(result.body) }
  }
  if (result.applied.length > 0) return { by: null, before, after: result.body.length, keptLines: lineCount(result.body) }
  return summarized(text)
}

/**
 * The single cut the plan proposes, on lines the lossless floor already
 * produced: head + tail + the error windows of `cutShape.ts` + middle lines
 * that are only a path (up to 200, else none, as `spareMiddle` does). A run of
 * one cut line stays, since its marker would be no shorter; no line is
 * truncated.
 */
function cutLines(lines: readonly string[], head: number, tail: number): string[] {
  const total = lines.length
  const keep = errorWindowMask(lines)
  for (let i = 0; i < Math.min(head, total); i++) keep[i] = true
  for (let i = Math.max(0, total - tail); i < total; i++) keep[i] = true
  const middlePaths: number[] = []
  for (let i = head; i < total - tail; i++) if (isPathLine(lines[i] ?? '')) middlePaths.push(i)
  if (middlePaths.length <= MAX_KEPT_PATH_LINES) for (const i of middlePaths) keep[i] = true
  const out: string[] = []
  for (let i = 0; i < total; ) {
    if (keep[i]) {
      out.push(lines[i++] ?? '')
      continue
    }
    let j = i
    let bytes = 0
    while (j < total && !keep[j]) bytes += (lines[j++] ?? '').length + 1
    if (j - i === 1) out.push(lines[i] ?? '')
    else out.push(`<omitted lines="${j - i}" bytes="${formatFileSize(bytes)}"/>`)
    i = j
  }
  return out
}

/**
 * A candidate on a cap-eligible body: past `trigger` lines — or, for a
 * diagnostics body, which keeps "no line cap", past the summarizer's 8k chars
 * (the plan's char backstop) — keep `head`+`tail`+error windows+paths.
 */
function oneCut(command: string, text: string, diagnostics: boolean, trigger: number, head: number, tail: number): Outcome {
  const floored = applyPipeline(losslessFloor(true, diagnostics, text), text, { allowShortCircuit: false }).body
  const uncut: Outcome = { by: null, before: floored.length, after: floored.length, keptLines: lineCount(floored) }
  if (!diagnostics && isBoundedRead(command, text)) return uncut
  const lines = floored.split('\n')
  const over = diagnostics ? floored.length >= BASH_SUMMARIZE_THRESHOLD : lines.length > trigger
  if (!over || lines.length <= head + tail + 1) return uncut
  const body = cutLines(lines, head, tail).join('\n')
  if (body.length >= floored.length) return uncut
  return { by: 'one-cut', before: floored.length, after: body.length, keptLines: lineCount(body) }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

type Row = { cut: number; removed: number; base: number; kept: number[] }

function tally(outcomes: readonly Outcome[]): Row {
  const row: Row = { cut: 0, removed: 0, base: 0, kept: [] }
  for (const o of outcomes) {
    row.base += o.before
    if (o.by === null) continue
    row.cut++
    row.removed += o.before - o.after
    row.kept.push(o.keptLines)
  }
  row.kept.sort((a, b) => a - b)
  return row
}

function rowCells(r: Row): string {
  return (
    `${padLeft(String(r.cut), 6)} ${padLeft(String(r.removed), 10)} ${padLeft(pct(r.removed, r.base), 7)} ` +
    `${padLeft(String(quantile(r.kept, 0.5)), 5)}/${pad(String(quantile(r.kept, 0.9)), 5)}`
  )
}

test('one cut versus today’s two cutters, and the read lane', () => {
  if (!existsSync(CORPUS_PATH)) {
    console.log(`no corpus at ${CORPUS_PATH} — build one with:\n  bun scripts/bench/tokens/extract-bash-corpus.ts --days 60`)
    return
  }
  // Failures take ERROR_FLOOR and no cap, and a matched spec decides its own
  // cut: the cap's fence, applied before anything else.
  const entries = readCorpus()
    .filter(e => !e.alreadyFiltered && !e.truncatedUpstream && !e.isError)
    .map(e => ({ command: e.command, text: unwrapRead(e.text) }))
    .filter(e => findFilterForCommand(e.command) === null)
    .map(e => ({
      ...e,
      lane: e.text.length <= FILE_READ_PASSTHROUGH_MAX_CHARS && isModelDirectedRead(e.command),
      eligible: isCappableBody(e.text),
      diagnostics: isCappableBody(e.text) && looksLikeDiagnostics(e.text),
    }))
  const capEligible = entries.filter(e => e.eligible && !e.diagnostics)
  const nonRead = capEligible.filter(e => !e.lane)
  const diagnostics = entries.filter(e => e.diagnostics)
  const todayOf = new Map(entries.map(e => [e, today(e.command, e.text)]))

  console.log(
    `\none cut — ${entries.length} raw, non-error, unmatched entries; cap-eligible ${capEligible.length} ` +
      `(${nonRead.length} not read-lane), diagnostics ${diagnostics.length}`,
  )
  console.log('  cells: results cut, chars removed by the cut, % of the set’s chars, kept lines median/p90')
  console.log(`  ${pad('policy', 30)} ${pad('all cap-eligible', 36)} non-read (lane would not keep)`)
  const printRow = (label: string, all: Outcome[], nr: Outcome[]) =>
    console.log(`  ${pad(label, 30)} ${rowCells(tally(all))}  ${rowCells(tally(nr))}`)

  const todayAll = capEligible.map(e => todayOf.get(e)!)
  const todayNonRead = nonRead.map(e => todayOf.get(e)!)
  printRow('TODAY cap60 15+15 → summ 8k', todayAll, todayNonRead)
  const byCutter = (os: Outcome[], by: Outcome['by']) => os.map(o => (o.by === by ? o : { ...o, by: null }))
  printRow('  of which cap', byCutter(todayAll, 'cap'), byCutter(todayNonRead, 'cap'))
  printRow('  of which summarizer', byCutter(todayAll, 'summarizer'), byCutter(todayNonRead, 'summarizer'))
  const todayNonReadRemoved = tally(todayNonRead).removed
  for (const trigger of ONE_CUT_TRIGGERS) {
    for (const { head, tail } of ONE_CUT_KEEPS) {
      const all = capEligible.map(e => oneCut(e.command, e.text, false, trigger, head, tail))
      const nr = all.filter((_, i) => !capEligible[i]!.lane)
      const ratio = pct(tally(nr).removed, todayNonReadRemoved)
      printRow(`ONE-CUT >${trigger} keep ${head}+${tail}`, all, nr)
      console.log(`  ${pad('', 30)} non-read removed = ${ratio} of TODAY’s`)
    }
  }

  // What the line trigger alone leaves whole that today's summarizer cut: a
  // short, wide result past 8k chars.
  for (const trigger of ONE_CUT_TRIGGERS) {
    const escaped = nonRead.filter(e => todayOf.get(e)!.by === 'summarizer' && e.text.split('\n').length <= trigger)
    console.log(
      `  ≤${trigger} lines but summarized today (non-read): ${escaped.length} results, ` +
        `${escaped.reduce((n, e) => n + (todayOf.get(e)!.before - todayOf.get(e)!.after), 0)} chars the line trigger gives back`,
    )
  }

  // Diagnostics keep "no line cap". Today the summarizer reaches one only when
  // the floor applied nothing to it; the plan's char backstop cuts at 8k with
  // the candidate's shape.
  console.log(`\n  diagnostics bodies: ${diagnostics.length}, ${diagnostics.reduce((n, e) => n + e.text.length, 0)} chars, ` +
    `${diagnostics.filter(e => e.text.length >= BASH_SUMMARIZE_THRESHOLD).length} at ≥8k`)
  console.log(`  ${pad('TODAY (summarizer only)', 30)} ${rowCells(tally(diagnostics.map(e => todayOf.get(e)!)))}`)
  for (const { head, tail } of ONE_CUT_KEEPS) {
    const os = diagnostics.map(e => oneCut(e.command, e.text, true, 0, head, tail))
    console.log(`  ${pad(`backstop 8k keep ${head}+${tail}`, 30)} ${rowCells(tally(os))}`)
  }

  // Outside the cap's fence the summarizer still cuts today; the plan keeps it
  // as the backstop there only when the filter did not run.
  const outside = readCorpus()
    .filter(e => !e.alreadyFiltered && !e.truncatedUpstream)
    .filter(e => e.isError || findFilterForCommand(e.command) !== null || !isCappableBody(unwrapRead(e.text)))
    .map(e => summarized(unwrapRead(e.text)))
  const o = tally(outside)
  console.log(`  outside the cap's fence (errors, matched specs, structured): summarizer cuts ${o.cut}, ${o.removed} chars`)

  // READ-LANE give-back: what today's cutters remove from reads the lane keeps.
  const lane = entries.filter(e => e.lane)
  const laneToday = tally(lane.map(e => todayOf.get(e)!))
  const laneChars = lane.reduce((n, e) => n + e.text.length, 0)
  console.log(
    `\n  READ-LANE give-back: ${lane.length} lane reads ≤${FILE_READ_PASSTHROUGH_MAX_CHARS} chars (${laneChars} chars); ` +
      `today cuts ${laneToday.cut} (cap ${lane.filter(e => todayOf.get(e)!.by === 'cap').length}, ` +
      `summarizer ${lane.filter(e => todayOf.get(e)!.by === 'summarizer').length}), removing ${laneToday.removed} chars ` +
      `the lane keeps (${pct(laneToday.removed, laneChars)} of lane-read chars)`,
  )
  const cappedReads = entries
    .filter(e => isModelDirectedRead(e.command) && todayOf.get(e)!.by === 'cap')
    .map(e => lineCount(e.text))
    .sort((a, b) => a - b)
  console.log(
    `  capped reads (lane grammar, any size): ${cappedReads.length}, original lines ` +
      `median ${quantile(cappedReads, 0.5)}, p90 ${quantile(cappedReads, 0.9)}`,
  )
}, 120_000)
