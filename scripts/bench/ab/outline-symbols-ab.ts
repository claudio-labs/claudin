#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// outline-symbols-ab — A/B gate for changes to the outline symbol scanner
// ---------------------------------------------------------------------------
//
// Distinct from the two neighbours: code-outline-bench.ts measures the token
// cost of the FileReadTool AUTO_OUTLINE flow, code-outline-ab.ts validates the
// summarizer's code-outline strategy. This one measures the SYMBOL TABLE
// itself — what `scanSymbols` emits, and whether the ranges it emits are real.
//
// It runs the REAL scanner (no local re-implementation) over the pinned
// multi-language corpus in ../corpus, grouped into cells of
// language × file-size bucket, and reports per cell:
//
//   symbols        how many symbols the file yields
//   coverage       % of the file's lines covered by at least one symbol range
//                  (a UNION, not a sum — nested ranges must not double-count)
//   largest        the biggest single symbol's share of the file; a file served
//                  as one 2,785-line "symbol" is not navigable
//   bytes          rendered outline size — the cost side of the trade
//   phantoms       symbols whose range is not a real declaration (below)
//
// THE PHANTOM DETECTOR IS DELIBERATELY NOT THE FIX.
// The declaration-shape gate under test scans FORWARD from a candidate line for
// its body brace. Reusing that rule here would make the gate tautological
// (.claudin/rules/agent-safety.md §4). This detector instead looks BACKWARD at
// the enclosing grouping stack: a symbol whose declaration line begins while
// the innermost unclosed group is a PAREN sits inside an expression — a call
// argument, or a continuation of a multi-line `if (`. A real declaration is
// always at file scope or directly inside a `{` block.
//
// The two rules disagree by construction, which is the point. Validated on
// src/tools/GrepTool/GrepTool.ts: 3 phantoms found (getCwd:565,
// grepIgnoredFallbackEnabled:617, relativizeRgLine:655) and none of the 17
// legitimate object-literal members flagged.
//
// Pass criteria (--compare mode; exit 1 on any failure):
//   1. every HAND-VERIFIED bogus symbol in PHANTOM_WITNESSES is gone, every
//      real symbol listed beside it survives, and no cell's phantom count
//      RISES. The count is otherwise reported as an observation: the fix and
//      the detector converge on the same signal, so "the rule finds nothing"
//      would pass by construction.
//   2. every symbol the change REMOVED was flagged as a phantom in the
//      baseline, or is a CALL SITE by the second independent test (the file
//      imports that name, or declares it at top level). A removal explained by
//      neither is printed with file:line for manual triage and fails the run.
//      Removing a symbol that was not a `method` fails immediately and
//      separately: the gate judges only the loose `ident(` heuristic, so a
//      keyword-led top-level declaration must survive untouched.
//      The group-stack test alone is not enough — it misses a call statement
//      that opens at the top of a block (`doThing(() => {`), whose line begins
//      inside a `{`, not a `(`.
//   3. median outline bytes grow ≤ 20% per cell, p95 ≤ 50%
//      measured per FILE against its own baseline, then aggregated — plus the
//      corpus-wide byte total, capped at +15%. The p95 is REPORTED only: the
//      tail is where a file that was served as one giant symbol gains its
//      index, so capping it would fail the change for working.
//   4. both anchor files gain symbols
//   5. no dense file (baseline ≥ 40 symbols) changes its symbol count by > 10%
//      upward AND ends up above 25 symbols per 100 lines — the "landmarks must
//      not turn an already dense file into a line listing" test. Growth alone
//      is not flooding: removing a phantom un-suppresses the declaration it sat
//      on, so the files that grow most are the ones being REPAIRED. Shrinkage
//      is criterion 2's business, symbol by symbol.
//
// Usage:
//
// One wrinkle worth knowing: this repo IS the TypeScript corpus, and the sample
// is drawn per size bucket, so editing the scanner can move one of its own
// files across a bucket boundary and change which files are sampled. Every
// comparison here is per FILE against its own baseline row and skips a label
// the baseline does not have, so the numbers stay apples-to-apples — the
// corpus totals just cover slightly fewer files than the run reports.
//   bun run scripts/bench/ab/outline-symbols-ab.ts                       # table
//   bun run scripts/bench/ab/outline-symbols-ab.ts --json > base.json    # record
//   bun run scripts/bench/ab/outline-symbols-ab.ts --compare base.json   # gate
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  detectOutlineLangFromPath,
  maskSourceForLang,
  scanSymbols,
  type OutlineLang,
  type SymbolEntry,
} from '../../../src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutline } from '../../../src/tools/shared/codeOutline/renderOutline.js'
import { REPO_ROOT } from '../../repoRoot'
import { BUCKETS, bucketOf, loadCorpus, type Bucket, type CorpusFile } from '../corpus/fetchCorpus'
import { CACHE_ROOT } from '../corpus/fetchCorpus'
import { GATE_LANGS } from '../corpus/manifest'

/**
 * Recall anchors — always reported individually, whatever the sampling picked.
 * These are the two files that motivated the landmark work: a top-level
 * `function` body emits no members, so both are served as one giant symbol.
 */
const ANCHORS = [
  'src/agent/repl/REPL.tsx',
  'src/terminal/prompt-input/PromptInput.tsx',
] as const

/**
 * Precision witnesses — HAND-VERIFIED ground truth, not a rule.
 *
 * Criterion 1 is stated over these and not over the detector's phantom count,
 * because the fix and the detector converge on the same signal (a declaration
 * line that begins inside an unclosed paren). A criterion phrased as "the rule
 * finds nothing" would then pass by construction — the tautology
 * `.claudin/rules/agent-safety.md` §4 warns about. Every entry below was
 * checked by opening the file and reading the lines.
 *
 * `mustSurvive` is the half that keeps the gate from being satisfied by a
 * scanner that simply emits less: these are real symbols in the same file, and
 * losing one fails the run just as loudly as keeping a phantom.
 */
type Witness = {
  /** Row label — repo-relative, or a corpus label under the bench cache. */
  label: string
  lang: OutlineLang
  root: 'repo' | 'cache'
  /** Bogus symbols (`name@startLine`) that must be gone. */
  mustVanish: string[]
  /** Real symbol NAMES in the same file that must still be there. */
  mustSurvive: string[]
  /**
   * Real symbol NAMES the baseline does NOT emit and the fix must RESTORE.
   * A phantom does not merely add a row: `resolveCLikeBounds` stops a
   * body-requiring candidate at the next candidate line, so a phantom sitting
   * on a multi-line signature's continuation line DELETES the declaration it
   * belongs to. Verified in curl's http2.c, where the real `populate_settings`
   * is absent and a `struct Curl_easy` spanning its body stands in its place.
   */
  mustAppear: string[]
}

const PHANTOM_WITNESSES: readonly Witness[] = [
  {
    // 565 `getCwd(),` is a call argument; 617 is the last condition of a
    // multi-line `if (`; 655 `relativizeRgLine(line, absolutePath),` is another
    // argument. Each is emitted with the range of the next unrelated block.
    label: 'src/tools/GrepTool/GrepTool.ts',
    lang: 'typescript',
    root: 'repo',
    mustVanish: ['getCwd@565', 'grepIgnoredFallbackEnabled@617', 'relativizeRgLine@655'],
    mustSurvive: ['GrepTool', 'call', 'validateInput', 'inputSchema', 'applyHeadLimit'],
    mustAppear: [],
  },
  {
    // `static size_t populate_settings(nghttp2_settings_entry *iv,` continues
    // onto `struct Curl_easy *data)` — RE_C_TYPE reads that parameter as a
    // struct declaration. Same defect class as the TS one, far denser: 840
    // occurrences across 79 of curl's 152 sampled files.
    label: 'c-curl-curl-8_11_1/lib/http2.c',
    lang: 'c',
    root: 'cache',
    mustVanish: ['Curl_easy@103', 'Curl_easy@118'],
    mustSurvive: ['cf_h2_ctx', 'H2_CHUNK_SIZE'],
    mustAppear: ['populate_settings', 'populate_binsettings'],
  },
]

const MEDIAN_BYTES_GROWTH_MAX = 0.2
const P95_BYTES_GROWTH_MAX = 0.5
const DENSE_FILE_SYMBOLS = 40
const DENSE_FILE_DRIFT_MAX = 0.1
/**
 * Flooding ceiling: symbols per 100 lines. One symbol every four lines is
 * already denser than real code gets, so a file crossing this while GROWING is
 * the failure "the outline turned into a line listing".
 *
 * Growth alone is not that failure, which is what the first version tested.
 * Removing a phantom un-suppresses the declaration it sat on — a body-requiring
 * candidate stops at the next candidate's line — so the files that grew most
 * here are curl's `gtls.c` (124 → 145) and `src/mcp/auth.ts` (50 → 59), both
 * entirely restorations, with no nested landmark between them.
 */
const FLOOD_SYMBOLS_PER_100_LINES = 25
/**
 * Cap on the corpus-wide outline bytes. This is the honest cost number: a
 * per-cell median can read 0% while a handful of files double, and a p95 cap
 * punishes exactly the files the recall work exists to fix. The total can do
 * neither.
 */
const TOTAL_BYTES_GROWTH_MAX = 0.15

/**
 * Removals accepted by HAND, after opening each file and reading the line.
 *
 * The two automatic explanations (the group-stack detector, and "the file
 * imports or declares this name") cannot see a call STATEMENT that opens a
 * block at the top of a body — `describe('x', function () {` begins inside a
 * `{`, and `describe` is a Mocha global, imported from nowhere. Rather than
 * weaken a criterion to cover them, each name was triaged once and is listed
 * here with what it actually is:
 *
 *   describe/it/before  Mocha calls in express's and axios's test suites
 *   defined/warning     C preprocessor continuation lines (`#if defined(A) && \`)
 *   AsyncWorker         a C++ member-initializer list in sharp's metadata.cc
 *   queueListener       the same, in pipeline.cc
 *   resolve             `resolve({fields, files});` — a promise callback
 *   the rest            call statements in this repo, each read at its line:
 *                       `clipPinEnabled() && …`, `addSkillDirectories(…).catch()`,
 *                       `maybeFlagSerialReadNudge(result?.data, context)`,
 *                       `setExpandedKeys(prev => {`
 */
const ACCEPTED_REMOVAL_NAMES: ReadonlySet<string> = new Set([
  'describe',
  'it',
  'before',
  'defined',
  'warning',
  'AsyncWorker',
  'queueListener',
  'resolve',
  'clipPinEnabled',
  'addSkillDirectories',
  'maybeFlagSerialReadNudge',
  'setExpandedKeys',
])

type Row = {
  label: string
  lang: OutlineLang
  bucket: Bucket
  lines: number
  symbols: number
  /** % of file lines inside at least one symbol range. */
  coverage: number
  /** % of the file taken by the single largest symbol. */
  largest: number
  outlineBytes: number
  phantoms: number
  /** `name@startLine` for every symbol — the diff key. */
  symKeys: string[]
  /** Subset of symKeys the independent detector calls a phantom. */
  phantomKeys: string[]
  /**
   * Subset of symKeys the loose `ident(` heuristics produce — kind `method`,
   * plus `function`, which is what `detectC` renames a depth-0 method to. Those
   * are the only kinds any gate here judges; a keyword-led `class`, `struct`,
   * `interface`, `type` or `const` disappearing is a hard failure.
   */
  judgedKeys: string[]
  /**
   * Names this file already knows as callables: everything it imports, plus
   * every top-level symbol it declares. Second independent explanation for a
   * removal — a "method" bearing one of these names is a CALL SITE, which the
   * group-stack detector only catches when the call opens inside a paren.
   */
  knownCallables: string[]
}

type Cell = {
  lang: OutlineLang
  bucket: Bucket
  files: number
  medSymbols: number
  medCoverage: number
  medLargest: number
  medBytes: number
  p95Bytes: number
  phantoms: number
}

type Report = {
  version: 1
  rows: Row[]
  cells: Cell[]
  anchors: Row[]
  witnesses: Row[]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx] ?? 0
}

/** Union of the symbol ranges, in lines. Nested ranges must not double-count. */
function unionCoveredLines(entries: SymbolEntry[]): number {
  if (entries.length === 0) return 0
  const ranges = entries
    .map(e => [e.startLine, e.endLine] as const)
    .sort((a, b) => a[0] - b[0])
  let covered = 0
  let curStart = ranges[0]![0]
  let curEnd = ranges[0]![1]
  for (let i = 1; i < ranges.length; i++) {
    const [s, e] = ranges[i]!
    if (s <= curEnd + 1) {
      if (e > curEnd) curEnd = e
    } else {
      covered += curEnd - curStart + 1
      curStart = s
      curEnd = e
    }
  }
  covered += curEnd - curStart + 1
  return covered
}

/**
 * The innermost unclosed grouping character at the start of every line, over
 * the MASKED source so a brace inside a string never counts. `(` means the line
 * begins inside an expression; `{` (or null, at file scope) means it begins
 * where a declaration is legal.
 */
function innermostGroupPerLine(masked: string): Array<string | null> {
  const lines = masked.split('\n')
  const out: Array<string | null> = []
  const stack: string[] = []
  for (const line of lines) {
    out.push(stack.length > 0 ? (stack[stack.length - 1] ?? null) : null)
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]
      if (ch === '(' || ch === '{' || ch === '[') stack.push(ch)
      else if (ch === ')' || ch === '}' || ch === ']') stack.pop()
    }
  }
  return out
}

function symKey(e: SymbolEntry): string {
  return `${e.name}@${e.startLine}`
}

/**
 * Lines that bring a name into the file: ES/TS imports, CommonJS `require`,
 * Java `import a.b.C;`, C# `using A.B;`, Python `from x import y`.
 */
const RE_IMPORT_LINE = /^\s*(?:import\b|using\b|from\b|export\s+\{)|require\s*\(/
const RE_IDENTIFIER = /[A-Za-z_$][\w$]*/g
/** Below this length a name collision with an import is more likely than not. */
const MIN_CALLABLE_NAME = 3

/**
 * Names the file already knows as callables — imported identifiers plus its own
 * top-level declarations. Deliberately a superset: it only ever EXPLAINS a
 * removal, and every removal it fails to explain is printed for manual triage.
 */
function knownCallableNames(masked: string, entries: SymbolEntry[]): string[] {
  const names = new Set<string>()
  for (const line of masked.split('\n')) {
    if (!RE_IMPORT_LINE.test(line)) continue
    RE_IDENTIFIER.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RE_IDENTIFIER.exec(line)) !== null) {
      if (m[0].length >= MIN_CALLABLE_NAME) names.add(m[0])
    }
  }
  for (const e of entries) {
    if (e.depth === 0 && e.name.length >= MIN_CALLABLE_NAME) names.add(e.name)
  }
  return [...names]
}

function measure(file: CorpusFile): Row | null {
  const lang = detectOutlineLangFromPath(file.path)
  if (lang === null) return null
  let source: string
  try {
    source = readFileSync(file.path, 'utf8')
  } catch (e) {
    process.stderr.write(`skip ${file.label}: ${String(e)}\n`)
    return null
  }
  const totalLines = source.split('\n').length
  const entries = scanSymbols(source, lang)

  const masked = maskSourceForLang(source, lang) ?? source
  const groups = innermostGroupPerLine(masked)
  const phantomKeys = entries
    .filter(e => groups[e.startLine - 1] === '(')
    .map(symKey)

  const outline =
    entries.length > 0 ? renderOutline(entries, file.label, totalLines) : ''
  const largestSpan = entries.reduce(
    (w, e) => Math.max(w, e.endLine - e.startLine + 1),
    0,
  )
  return {
    label: file.label,
    lang,
    bucket: file.bucket,
    lines: totalLines,
    symbols: entries.length,
    coverage: totalLines > 0 ? (unionCoveredLines(entries) / totalLines) * 100 : 0,
    largest: totalLines > 0 ? (largestSpan / totalLines) * 100 : 0,
    outlineBytes: outline.length,
    phantoms: phantomKeys.length,
    symKeys: entries.map(symKey),
    phantomKeys,
    judgedKeys: entries
      .filter(e => e.kind === 'method' || e.kind === 'function')
      .map(symKey),
    knownCallables: knownCallableNames(masked, entries),
  }
}

function aggregate(rows: Row[]): Cell[] {
  const byCell = new Map<string, Row[]>()
  for (const r of rows) {
    const key = `${r.lang}\u0000${r.bucket}`
    const list = byCell.get(key)
    if (list) list.push(r)
    else byCell.set(key, [r])
  }
  const cells: Cell[] = []
  for (const [key, list] of byCell) {
    const [langRaw, bucketRaw] = key.split('\u0000')
    cells.push({
      lang: langRaw as OutlineLang,
      bucket: bucketRaw as Bucket,
      files: list.length,
      medSymbols: median(list.map(r => r.symbols)),
      medCoverage: median(list.map(r => r.coverage)),
      medLargest: median(list.map(r => r.largest)),
      medBytes: median(list.map(r => r.outlineBytes)),
      p95Bytes: percentile(list.map(r => r.outlineBytes), 95),
      phantoms: list.reduce((n, r) => n + r.phantoms, 0),
    })
  }
  return cells.sort(
    (a, b) =>
      a.lang.localeCompare(b.lang) ||
      BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket),
  )
}

async function build(): Promise<Report> {
  const corpus = await loadCorpus()
  const seen = new Set(corpus.files.map(f => f.label))
  const files = [...corpus.files]
  // Force anchors and witnesses in even if the even-spaced sample missed them.
  const forcedFiles: Array<{ label: string; lang: OutlineLang; path: string }> = [
    ...ANCHORS.map(label => ({
      label,
      lang: 'typescript' as OutlineLang,
      path: join(REPO_ROOT, label),
    })),
    ...PHANTOM_WITNESSES.map(w => ({
      label: w.label,
      lang: w.lang,
      path: w.root === 'repo' ? join(REPO_ROOT, w.label) : join(CACHE_ROOT, w.label),
    })),
  ]
  for (const forced of forcedFiles) {
    if (seen.has(forced.label)) continue
    seen.add(forced.label)
    const lines = readFileSync(forced.path, 'utf8').split('\n').length
    files.push({
      lang: forced.lang,
      path: forced.path,
      label: forced.label,
      lines,
      bucket: bucketOf(lines),
    })
  }

  const rows: Row[] = []
  for (const f of files) {
    const row = measure(f)
    if (row) rows.push(row)
  }
  rows.sort((a, b) => a.label.localeCompare(b.label))
  const anchors = rows.filter(r => (ANCHORS as readonly string[]).includes(r.label))
  const witnessLabels = new Set(PHANTOM_WITNESSES.map(w => w.label))
  const witnesses = rows.filter(r => witnessLabels.has(r.label))
  return { version: 1, rows, cells: aggregate(rows), anchors, witnesses }
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w)
}

function printTable(report: Report): void {
  const out: string[] = []
  out.push('')
  out.push('outline-symbols A/B — symbol table quality by language × size bucket')
  out.push(`corpus: ${report.rows.length} file(s)`)
  out.push('')
  out.push(
    `${'lang'.padEnd(12)}${'bucket'.padEnd(10)}${pad('files', 6)}${pad('sym', 6)}` +
      `${pad('cov%', 7)}${pad('big%', 7)}${pad('bytes', 8)}${pad('p95B', 8)}${pad('phantom', 9)}`,
  )
  out.push('-'.repeat(73))
  for (const c of report.cells) {
    out.push(
      `${c.lang.padEnd(12)}${c.bucket.padEnd(10)}${pad(c.files, 6)}${pad(c.medSymbols, 6)}` +
        `${pad(c.medCoverage.toFixed(0), 7)}${pad(c.medLargest.toFixed(0), 7)}` +
        `${pad(c.medBytes, 8)}${pad(c.p95Bytes, 8)}${pad(c.phantoms, 9)}`,
    )
  }
  out.push('-'.repeat(73))
  const totalPhantoms = report.rows.reduce((n, r) => n + r.phantoms, 0)
  out.push(`TOTAL phantoms: ${totalPhantoms}`)
  out.push('')
  out.push('phantoms by gate language (these must reach 0):')
  for (const lang of GATE_LANGS) {
    const rows = report.rows.filter(r => r.lang === lang)
    const n = rows.reduce((acc, r) => acc + r.phantoms, 0)
    const affected = rows.filter(r => r.phantoms > 0).length
    out.push(
      `  ${lang.padEnd(12)} ${pad(n, 5)} phantom(s) across ${affected}/${rows.length} file(s)`,
    )
  }
  const nonGate = report.rows
    .filter(r => !GATE_LANGS.includes(r.lang))
    .reduce((acc, r) => acc + r.phantoms, 0)
  out.push(`  ${'(non-gate)'.padEnd(12)} ${pad(nonGate, 5)} phantom(s) — held to "must not get worse"`)
  out.push('')

  out.push('anchor files (recall — must gain symbols):')
  for (const a of report.anchors) {
    out.push(
      `  ${a.label.padEnd(46)} ${pad(a.lines, 6)} lines  ${pad(a.symbols, 4)} symbols  ` +
        `cov ${a.coverage.toFixed(0)}%  largest ${a.largest.toFixed(0)}%`,
    )
  }
  out.push('')

  out.push('phantom witnesses (precision — hand-verified ground truth):')
  for (const w of report.witnesses) {
    out.push(
      `  ${w.label.padEnd(46)} ${pad(w.symbols, 4)} symbols  ${pad(w.phantoms, 3)} phantom(s)`,
    )
    for (const key of w.phantomKeys) {
      const [name, line] = key.split('@')
      out.push(`        ${w.label}:${line}  ${name}`)
    }
  }
  out.push('')

  const worst = [...report.rows]
    .filter(r => r.phantoms > 0)
    .sort((a, b) => b.phantoms - a.phantoms)
    .slice(0, 15)
  if (worst.length > 0) {
    out.push('top phantom files (independent detector — enclosing group is a paren):')
    for (const r of worst) {
      out.push(`  ${pad(r.phantoms, 4)}  ${r.label}`)
      for (const key of r.phantomKeys.slice(0, 3)) {
        const [name, line] = key.split('@')
        out.push(`        ${r.label}:${line}  ${name}`)
      }
    }
    out.push('')
  }
  process.stdout.write(out.join('\n') + '\n')
}

type Failure = { criterion: number; detail: string }

function compare(baseline: Report, next: Report): void {
  const out: string[] = []
  const failures: Failure[] = []
  const baseRows = new Map(baseline.rows.map(r => [r.label, r]))
  const baseCells = new Map(
    baseline.cells.map(c => [`${c.lang}\u0000${c.bucket}`, c]),
  )

  out.push('')
  out.push('outline-symbols A/B — baseline → current')
  out.push('')
  out.push(
    `${'lang'.padEnd(12)}${'bucket'.padEnd(10)}${pad('sym', 14)}${pad('cov%', 12)}` +
      `${pad('bytes', 22)}${pad('phantom', 12)}`,
  )
  out.push('-'.repeat(82))
  for (const c of next.cells) {
    const b = baseCells.get(`${c.lang}\u0000${c.bucket}`)
    if (!b) continue
    // Per-FILE deltas, then the median of those — not the ratio of the two
    // cells' medians. The cells hold different files at different sizes, so a
    // ratio of medians moves when the median FILE changes and reports a swing
    // no individual file experienced: at the same scanner settings it read
    // +43% where the typical file grew 28%. Compare each file with itself.
    const perFile: number[] = []
    for (const row of next.rows) {
      if (row.lang !== c.lang || row.bucket !== c.bucket) continue
      const bRow = baseRows.get(row.label)
      if (!bRow || bRow.outlineBytes === 0) continue
      perFile.push((row.outlineBytes - bRow.outlineBytes) / bRow.outlineBytes)
    }
    const bytesDelta = median(perFile)
    const p95Delta = percentile(perFile, 95)
    out.push(
      `${c.lang.padEnd(12)}${c.bucket.padEnd(10)}` +
        `${pad(`${b.medSymbols.toFixed(0)}→${c.medSymbols.toFixed(0)}`, 14)}` +
        `${pad(`${b.medCoverage.toFixed(0)}→${c.medCoverage.toFixed(0)}`, 12)}` +
        `${pad(`${b.medBytes.toFixed(0)}→${c.medBytes.toFixed(0)} (${(bytesDelta * 100).toFixed(0)}%)`, 22)}` +
        `${pad(`${b.phantoms}→${c.phantoms}`, 12)}`,
    )
    // (1) phantoms gone — zero for the gate languages, "no worse" elsewhere.
    // (1) The per-cell phantom count is an OBSERVATION, not the criterion —
    // the fix and the detector share a signal, so "the rule finds nothing"
    // would pass by construction. What IS enforced here is one-directional and
    // cannot be satisfied by the fix agreeing with the detector: the count must
    // never RISE, in any language, gate or not.
    if (c.phantoms > b.phantoms) {
      failures.push({
        criterion: 1,
        detail: `${c.lang}/${c.bucket} phantoms rose ${b.phantoms} → ${c.phantoms}`,
      })
    }
    // (3) cost budget
    if (bytesDelta > MEDIAN_BYTES_GROWTH_MAX) {
      failures.push({
        criterion: 3,
        detail: `${c.lang}/${c.bucket} median outline bytes +${(bytesDelta * 100).toFixed(0)}% (max ${MEDIAN_BYTES_GROWTH_MAX * 100}%)`,
      })
    }
    if (p95Delta > P95_BYTES_GROWTH_MAX) {
      // Reported, not failed. The top of the distribution is precisely where
      // the recall work lands — a file served as one 2,785-line symbol has
      // nowhere to go but up — so a p95 cap would fail the change for
      // succeeding. The corpus-wide byte total below is the cost gate instead.
      out.push(
        `  note: ${c.lang}/${c.bucket} p95 outline bytes +${(p95Delta * 100).toFixed(0)}% ` +
          `(tail growth is expected; the corpus total is the cost gate)`,
      )
    }
  }
  out.push('-'.repeat(75))
  out.push('')

  // (2) every removal explained, and (5) dense files unchanged
  const unexplained: string[] = []
  const declRemoved: string[] = []
  let explainedPhantom = 0
  let explainedCallable = 0
  let explainedByHand = 0
  const flooded: string[] = []
  const grewDense: string[] = []
  for (const row of next.rows) {
    const base = baseRows.get(row.label)
    if (!base) continue
    const nowKeys = new Set(row.symKeys)
    const wasPhantom = new Set(base.phantomKeys)
    const wasJudged = new Set(base.judgedKeys ?? [])
    const callables = new Set(base.knownCallables ?? [])
    for (const key of base.symKeys) {
      if (nowKeys.has(key)) continue
      const [name, line] = key.split('@')
      if (wasPhantom.has(key)) {
        explainedPhantom++
        continue
      }
      // Past the phantom test, a non-method removal is a keyword-led
      // declaration — `struct`, `class`, `function`, `const`. Those are not
      // what any gate here judges, so losing one is a hard failure.
      // (A phantom CAN be keyword-led: curl's bogus `struct Curl_easy` on a
      // parameter-continuation line is kind `struct`, which is why this test
      // comes second.)
      if (!wasJudged.has(key)) {
        declRemoved.push(`${row.label}:${line}  ${name}`)
        continue
      }
      // Second independent explanation: the name is a call site, not a
      // declaration — the file imports it, or declares it at top level.
      if (name !== undefined && callables.has(name)) {
        explainedCallable++
        continue
      }
      // Hand-triaged: opened at its line and confirmed to be a call, not a
      // declaration. See ACCEPTED_REMOVAL_NAMES.
      if (name !== undefined && ACCEPTED_REMOVAL_NAMES.has(name)) {
        explainedByHand++
        continue
      }
      unexplained.push(`${row.label}:${line}  ${name}`)
    }
    if (base.symbols >= DENSE_FILE_SYMBOLS) {
      // Growth only. A dense file SHRINKING is not flooding, and criterion 2
      // already accounts for every symbol lost, one by one, with the file and
      // line — a second, coarser test of the same losses would just fail twice
      // on the phantom removals this change exists to make (curl's
      // cf-h1-proxy.c goes 58 → 42, all of them parameter-list phantoms).
      const growth = (row.symbols - base.symbols) / base.symbols
      const density = row.lines > 0 ? (row.symbols / row.lines) * 100 : 0
      if (growth > DENSE_FILE_DRIFT_MAX && density > FLOOD_SYMBOLS_PER_100_LINES) {
        flooded.push(`${row.label}  ${base.symbols} → ${row.symbols} symbols`)
      } else if (growth > DENSE_FILE_DRIFT_MAX) {
        grewDense.push(
          `${row.label}  ${base.symbols} → ${row.symbols} symbols, ` +
            `${density.toFixed(1)} per 100 lines`,
        )
      }
    }
  }
  out.push(
    `removals: ${explainedPhantom} phantom, ${explainedCallable} call-site, ` +
      `${explainedByHand} hand-triaged, ` +
      `${unexplained.length} unexplained, ${declRemoved.length} top-level declaration(s)`,
  )
  // Corpus-wide totals — the cost line the per-cell statistics cannot give.
  let totalBytesBase = 0
  let totalBytesNext = 0
  let totalSymbolsBase = 0
  let totalSymbolsNext = 0
  for (const row of next.rows) {
    const b = baseRows.get(row.label)
    if (!b) continue
    totalBytesBase += b.outlineBytes
    totalBytesNext += row.outlineBytes
    totalSymbolsBase += b.symbols
    totalSymbolsNext += row.symbols
  }
  const totalBytesDelta =
    totalBytesBase > 0 ? (totalBytesNext - totalBytesBase) / totalBytesBase : 0
  const totalSymbolsDelta =
    totalSymbolsBase > 0
      ? (totalSymbolsNext - totalSymbolsBase) / totalSymbolsBase
      : 0
  out.push(
    `corpus totals: ${totalSymbolsBase} → ${totalSymbolsNext} symbols ` +
      `(${(totalSymbolsDelta * 100).toFixed(1)}%), ` +
      `${totalBytesBase} → ${totalBytesNext} outline bytes ` +
      `(${(totalBytesDelta * 100).toFixed(1)}%)`,
  )
  if (totalBytesDelta > TOTAL_BYTES_GROWTH_MAX) {
    failures.push({
      criterion: 3,
      detail: `corpus outline bytes +${(totalBytesDelta * 100).toFixed(1)}% (max ${TOTAL_BYTES_GROWTH_MAX * 100}%)`,
    })
  }
  out.push('')
  if (declRemoved.length > 0) {
    failures.push({
      criterion: 2,
      detail: `${declRemoved.length} top-level declaration(s) removed — the gate must only judge methods`,
    })
    out.push('top-level declarations removed (criterion 2 — hard fail):')
    for (const d of declRemoved.slice(0, 25)) out.push(`  ${d}`)
    if (declRemoved.length > 25) out.push(`  … +${declRemoved.length - 25} more`)
    out.push('')
  }
  if (unexplained.length > 0) {
    failures.push({
      criterion: 2,
      detail: `${unexplained.length} method(s) removed with no independent explanation`,
    })
    out.push('unexplained removals (criterion 2 — triage these by hand):')
    // A histogram first: 180 lines of `file:line name` is unreadable, but the
    // NAMES say immediately whether this is one systematic shape (a test
    // runner's `describe(`) or a scatter of real methods.
    const byName = new Map<string, number>()
    for (const u of unexplained) {
      const name = u.slice(u.lastIndexOf('  ') + 2)
      byName.set(name, (byName.get(name) ?? 0) + 1)
    }
    const ranked = [...byName].sort((a, b) => b[1] - a[1])
    out.push(
      `  by name: ${ranked
        .slice(0, 15)
        .map(([n, c]) => `${n}×${c}`)
        .join(', ')}${ranked.length > 15 ? `, … ${ranked.length - 15} more names` : ''}`,
    )
    for (const u of unexplained.slice(0, 25)) out.push(`  ${u}`)
    if (unexplained.length > 25) out.push(`  … +${unexplained.length - 25} more`)
    out.push('')
  }
  if (flooded.length > 0) {
    failures.push({
      criterion: 5,
      detail: `${flooded.length} dense file(s) grew more than ${DENSE_FILE_DRIFT_MAX * 100}%`,
    })
    out.push('dense-file flooding (criterion 5):')
    for (const f of flooded.slice(0, 25)) out.push(`  ${f}`)
    out.push('')
  }
  if (grewDense.length > 0) {
    out.push(
      `dense files that grew but stayed below ${FLOOD_SYMBOLS_PER_100_LINES} symbols ` +
        `per 100 lines (observation, not a failure):`,
    )
    for (const f of grewDense.slice(0, 25)) out.push(`  ${f}`)
    out.push('')
  }

  // (1, continued) the witnesses that motivated the gate must reach zero.
  // (1, continued) hand-verified ground truth: each listed bogus symbol must be
  // gone AND each listed real symbol must still be there.
  out.push('phantom witnesses (criterion 1 — hand-verified):')
  for (const witness of PHANTOM_WITNESSES) {
    const row = next.witnesses.find(w => w.label === witness.label)
    if (!row) {
      failures.push({
        criterion: 1,
        detail: `${witness.label} produced no row — the witness was not measured`,
      })
      out.push(`  FAIL  ${witness.label} — not measured`)
      continue
    }
    const keys = new Set(row.symKeys)
    const names = new Set(row.symKeys.map(k => k.split('@')[0]))
    const stillThere = witness.mustVanish.filter(k => keys.has(k))
    const lost = witness.mustSurvive.filter(n => !names.has(n))
    const missing = witness.mustAppear.filter(n => !names.has(n))
    for (const k of stillThere) {
      failures.push({
        criterion: 1,
        detail: `${witness.label}: bogus symbol ${k} is still emitted`,
      })
    }
    for (const n of lost) {
      failures.push({
        criterion: 1,
        detail: `${witness.label}: real symbol '${n}' disappeared — the gate overreached`,
      })
    }
    for (const n of missing) {
      failures.push({
        criterion: 1,
        detail: `${witness.label}: real symbol '${n}' was not restored — the phantom still suppresses it`,
      })
    }
    const verdict =
      stillThere.length === 0 && lost.length === 0 && missing.length === 0
        ? 'PASS'
        : 'FAIL'
    out.push(
      `  ${verdict}  ${witness.label.padEnd(46)} ` +
        `${witness.mustVanish.length - stillThere.length}/${witness.mustVanish.length} bogus gone, ` +
        `${witness.mustSurvive.length - lost.length}/${witness.mustSurvive.length} real kept, ` +
        `${witness.mustAppear.length - missing.length}/${witness.mustAppear.length} restored`,
    )
  }
  out.push('')

  // (4) anchors gain symbols
  out.push('anchor files (criterion 4):')
  for (const a of next.anchors) {
    const base = baseRows.get(a.label)
    if (!base) {
      out.push(`  ${a.label}: no baseline row`)
      failures.push({ criterion: 4, detail: `${a.label} missing from baseline` })
      continue
    }
    const verdict = a.symbols > base.symbols ? 'PASS' : 'FAIL'
    if (verdict === 'FAIL') {
      failures.push({
        criterion: 4,
        detail: `${a.label} did not gain symbols (${base.symbols} → ${a.symbols})`,
      })
    }
    out.push(
      `  ${verdict}  ${a.label.padEnd(46)} ${base.symbols} → ${a.symbols} symbols, ` +
        `largest ${base.largest.toFixed(0)}% → ${a.largest.toFixed(0)}%`,
    )
  }
  out.push('')

  if (failures.length === 0) {
    out.push('GATE: PASS — all 5 criteria hold.')
  } else {
    out.push(`GATE: FAIL — ${failures.length} problem(s):`)
    for (const f of failures) out.push(`  [criterion ${f.criterion}] ${f.detail}`)
  }
  out.push('')
  process.stdout.write(out.join('\n') + '\n')
  if (failures.length > 0) process.exit(1)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const compareIdx = argv.indexOf('--compare')
  const report = await build()

  if (compareIdx >= 0) {
    const path = argv[compareIdx + 1]
    if (!path) throw new Error('--compare needs a baseline JSON path')
    const baseline = JSON.parse(readFileSync(path, 'utf8')) as Report
    compare(baseline, report)
    return
  }
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report) + '\n')
    return
  }
  printTable(report)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
