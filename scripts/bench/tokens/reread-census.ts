#!/usr/bin/env bun
/**
 * Re-read census: how often a recorded session read a file it had already
 * read, with no write to it in between, and why.
 *
 *   bun scripts/bench/tokens/reread-census.ts [--since=YYYY-MM-DD] [--exclude=<session-prefix>]
 *     [--levers [--call-usd=0.105] [--write-usd=8]]
 *
 * A read is a Read (one file, a batch, a range, an outline) or a Bash print of
 * a file (`cat`, `sed -n`, `head`, `tail`, a non-recursive `grep` over named
 * files). A write is an Edit, Write or Patch on the file, or the
 * `refreshedFiles` a tool_result names (own writes). Each re-read gets one
 * cause, first match wins:
 *
 *   unchanged stub   the harness answered "File unchanged since last read"
 *   outline → body   the earlier read was an outline and nothing whole came
 *                    before — `asked` when the model passed view: 'outline',
 *                    `auto` when Read pivoted on its own (a batch entry too)
 *   after a Bash cut the earlier read was a Bash result the filter cut or
 *                    persisted, and nothing whole came before
 *   duplicate        every line asked for was already shown — split by the
 *                    distance in calls, and by an idle gap over an hour
 *                    (a relief clip may have stubbed the earlier result)
 *   new lines        the rest: paging, or a wider range
 *
 * Written for the 10-25..30 census (team memory
 * `census-2026-10-30-cache-tools-context`), which asked whether the Bash
 * filter made the model read files again: it did not, outlines did. Sub-agent
 * transcripts carry no `toolUseResult`, so a Read's range is read off the
 * `N→` line numbers of its text. Records are bounded by timestamp, not file
 * mtime: a session active in the window holds its older days too. `/tmp`
 * projects (the A/B benches) are left out.
 *
 * `--levers` replays three mechanisms over the main threads (sub-agent files
 * and `isSidechain` records left out) and says what each would have removed
 * and added. An API call is one assistant response (`message.id`); a Read is
 * alone when it is its call's only tool. The census of 11-04..11 asked for it:
 * 45 of 125 main Reads were the third or later slice of their file.
 *
 *   A grep bodies      a content-mode Grep whose matches fall in 1-5 symbols,
 *                      each within MAX_BODY_LINES and together within
 *                      BODIES_BUDGET_CHARS (`GrepTool/grepBodies.ts`), carries
 *                      their bodies; a range Read inside them in the next 3
 *                      API calls, with no write to the file between, is served
 *   B range → symbol   a range Read with limit ≤ 80 also returns the symbols
 *                      its lines sit in, whole, smallest first, while they add
 *                      at most 150 lines; a later range Read inside the lines
 *                      shown so far is served
 *   C whole on 3rd     the third distinct range of a file of at most 600
 *                      lines and 25,000 chars returns the file; every later
 *                      range Read of it is served
 *
 * A write to the file resets all of it, and each lever is replayed on its own,
 * against the reads the thread really made. The columns:
 *
 *   triggers   calls the mechanism would have answered with more than asked
 *   served     follow-up range Reads it made unnecessary
 *   saved      the served Reads that were alone: the API calls removed
 *   repeats    Reads its lines cover that an earlier real read of the thread
 *              covered too. The model made them with the lines already shown,
 *              so they are not served — add them to `served` for the ceiling
 *   returned   chars every trigger adds beyond its own result
 *   added      `returned` less the chars of the served Reads, in chars and in
 *              tokens (chars / 4)
 *   net $      saved × call-usd − added tokens × write-usd / 1e6
 *
 * A mechanism passes with saved ≥ 2% of the main API calls and net > 0. Lines
 * and symbols are the file's on disk NOW (`scanFile`, Read's own scanner): a
 * range Read of a file that is gone, or shorter than the range, is counted as
 * unresolvable and left out of everything, and so is a Grep that matched one.
 * Run it with the test preload, which stubs what the scanner's imports reach
 * outside the bundle (on 2026-11-11 a bare run loaded too, with the same
 * numbers, but nothing holds those imports to that):
 *
 *   NODE_ENV=test bun --preload ./src/stubs/test-preload.ts \
 *     scripts/bench/tokens/reread-census.ts --levers --since=2026-11-04
 */
import { readFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { BODIES_BUDGET_CHARS, MAX_BODY_LINES } from 'src/tools/GrepTool/grepBodies.js'
import { detectOutlineLangFromPath, enclosingSymbol, type SymbolEntry } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { configDir, contentText, padLeft, pct, projectDirs, transcriptFiles, type Block } from './transcriptCorpus'

type Range = readonly [number, number]
const WHOLE: Range = [1, Number.POSITIVE_INFINITY]

/** One tool call with its result, as the census needs it. */
export type CensusCall = {
  tool: string
  input: Block
  text: string
  isError: boolean
  /** The structured result when the transcript kept one (main threads only). */
  result: Block | null
  ts: number
  cwd: string
  refreshed: string[]
}

type Read = { idx: number; file: string; viaBash: boolean; range: Range | null; kind: string; ts: number }

export type RereadCounts = Record<string, number>

const OUTLINE_TEXT_RE = /is large — showing a structural outline|^Structural outline of /m
const NUMBERED_LINE_RE = /^\s*(\d+)→/gm
const BATCH_SPLIT_RE = /^==> (.+?) <==$/m
const UNCHANGED_RE = /^File unchanged since last read/m
const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
const PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/gm
const SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\n|\|)\s*/
const HEREDOC_RE = /<<\s*'?\w+/
const SED_RANGE_RE = /^'?"?(\d+)(?:,(\d+))?p'?"?$/
const CUT_RE = /^<bash-output-filtered[^>]*lines="(\d+)\/(\d+)"/
const PRINTERS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'sed', 'grep'])
const HOUR_MS = 3_600_000
const GREP_HEADER_RE = /^--- (.+) ---$/
const GREP_PATHLESS_RE = /^(\d+):/
// No whitespace in the path: a context line (`path-12-  a ? b:3:c`) must not read as a match.
const GREP_MATCH_RE = /^([^:\s]+):(\d+):/
const GREP_MAX_BODIES = 5
const GREP_REACH_CALLS = 3
const SNAP_MAX_LIMIT = 80
const SNAP_MAX_EXTRA_LINES = 150
const WHOLE_FROM_SLICE = 3
const WHOLE_MAX_LINES = 600
const WHOLE_MAX_CHARS = 25_000
const PASS_SHARE = 0.02
const DEFAULT_CALL_USD = 0.105
const DEFAULT_WRITE_USD_PER_MTOK = 8

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd || '/', path)
}

function rangeOfText(text: string): Range | null {
  const numbers = [...text.matchAll(NUMBERED_LINE_RE)].map(m => Number(m[1]))
  return numbers.length > 0 ? [numbers[0]!, numbers[numbers.length - 1]!] : null
}

function readsOfRead(call: CensusCall, idx: number): Read[] {
  const input = call.input as { file_path?: string; file_paths?: string[]; symbol?: unknown; view?: string }
  const paths = input.file_paths ?? (input.file_path ? [input.file_path] : [])
  const batch = paths.length > 1
  const read = (file: string, range: Range | null, kind: string): Read => ({
    idx, file: absolute(file, call.cwd), viaBash: false, range, kind, ts: call.ts,
  })
  if (call.isError) return []
  const result = call.result as { type?: string; file?: { startLine?: number; numLines?: number }; files?: { filePath: string; lines?: number }[] } | null
  if (result?.type === 'batch' && Array.isArray(result.files)) {
    return result.files.map(f => (f.lines ?? 0) > 0 ? read(f.filePath, [1, f.lines!], 'batch') : read(f.filePath, null, 'outline'))
  }
  const sections = batch ? call.text.split(BATCH_SPLIT_RE) : ['', paths[0] ?? '', call.text]
  const out: Read[] = []
  for (let s = 1; s + 1 < sections.length; s += 2) {
    const file = sections[s]!.trim()
    const body = sections[s + 1]!
    if (result?.type === 'file_unchanged' || UNCHANGED_RE.test(body)) out.push(read(file, null, 'unchanged'))
    else if (result?.type === 'outline' || (OUTLINE_TEXT_RE.test(body) && rangeOfText(body.split('\n').slice(0, 8).join('\n')) === null)) {
      out.push(read(file, null, input.view === 'outline' ? 'outline asked' : 'outline'))
    } else out.push(read(file, rangeOfText(body), input.symbol ? 'symbol' : 'text'))
  }
  return out
}

function readsOfBash(call: CensusCall, idx: number): Read[] {
  const command = typeof call.input.command === 'string' ? call.input.command : ''
  if (call.isError || HEREDOC_RE.test(command)) return []
  const cut = call.text.startsWith('<persisted-output>') || (() => {
    const m = CUT_RE.exec(call.text)
    return m !== null && Number(m[1]) < Number(m[2])
  })()
  const out: Read[] = []
  let cwd = call.cwd
  for (const segment of command.split(SEGMENT_SPLIT_RE)) {
    const [head, ...args] = segment.trim().split(/\s+/)
    if (!head) continue
    if (head === 'cd' && args[0]) {
      cwd = absolute(args[0].replace(/^["']|["']$/g, ''), cwd)
      continue
    }
    if (!PRINTERS.has(head)) continue
    if (head === 'grep' && args.some(a => /^-[^-]*[rR]/.test(a) || a === '--recursive')) continue
    let range: Range | null = WHOLE
    if (head === 'sed') {
      const script = args.find(a => SED_RANGE_RE.test(a))
      if (!script || !args.includes('-n')) continue
      const m = SED_RANGE_RE.exec(script)!
      range = [Number(m[1]), Number(m[2] ?? m[1])]
    } else if (head !== 'cat') range = null
    const operands = args.filter(a => !a.startsWith('-') && !/^\d+$/.test(a))
    for (const word of head === 'grep' || head === 'sed' ? operands.slice(1) : operands) {
      const path = word.replace(/^["']|["']$/g, '')
      if (/[$`*{}()<>~]/.test(path) || !/[./]/.test(path)) continue
      out.push({ idx, file: absolute(path, cwd), viaBash: true, range: cut ? null : range, kind: cut ? 'cut' : 'bash', ts: call.ts })
    }
  }
  return out
}

function writesOf(call: CensusCall): string[] {
  const out = call.refreshed.map(p => absolute(p, call.cwd))
  const path = call.input.file_path
  if (['Edit', 'Write', 'NotebookEdit'].includes(call.tool) && typeof path === 'string') out.push(absolute(path, call.cwd))
  const patch = call.input.patchText
  if (call.tool === 'Patch' && typeof patch === 'string') {
    for (const m of patch.matchAll(PATCH_FILE_RE)) out.push(absolute(m[1]!.trim(), call.cwd))
    for (const m of patch.matchAll(PATCH_MOVE_RE)) out.push(absolute(m[1]!.trim(), call.cwd))
  }
  return out
}

function covered(range: Range, shown: readonly Range[]): boolean {
  let next = range[0]
  for (const [from, to] of [...shown].sort((a, b) => a[0] - b[0])) {
    if (from > next) break
    if (to >= next) next = to + 1
    if (next > range[1]) return true
  }
  return next > range[1]
}

/** Every read and re-read of one thread, by cause. */
export function rereadsOfThread(calls: readonly CensusCall[], into: RereadCounts = {}): RereadCounts {
  const add = (key: string) => {
    into[key] = (into[key] ?? 0) + 1
  }
  const seen = new Map<string, { ranges: Range[]; last: Read; outline: string | null; cut: boolean }>()
  calls.forEach((call, idx) => {
    for (const file of writesOf(call)) seen.delete(file)
    const reads = call.tool === 'Read' ? readsOfRead(call, idx) : call.tool === 'Bash' ? readsOfBash(call, idx) : []
    for (const read of reads) {
      add('reads')
      const prev = seen.get(read.file)
      if (prev) {
        const gap = idx - prev.last.idx
        let cause: string
        if (read.kind === 'unchanged') cause = 'unchanged stub'
        else if (prev.outline && prev.ranges.length === 0) cause = `${prev.outline === 'outline asked' ? 'asked' : 'auto'} outline → body`
        else if (prev.cut && prev.ranges.length === 0) cause = 'after a Bash cut'
        else if (read.range && covered(read.range, prev.ranges)) {
          cause = read.ts - prev.last.ts > HOUR_MS ? 'duplicate after >1h idle' : gap <= 3 ? 'duplicate within 3 calls' : 'duplicate later'
        } else cause = 'new lines'
        add(`reread: ${cause}`)
      }
      const state = prev ?? { ranges: [], last: read, outline: null, cut: false }
      state.last = read
      if (read.range && read.kind !== 'unchanged') state.ranges.push(read.range)
      if (read.kind.startsWith('outline')) state.outline ??= read.kind
      if (read.kind === 'cut') state.cut = true
      seen.set(read.file, state)
    }
  })
  return into
}

/** What the lever replay needs of a file: its lines, and its symbols when the outline scanner reads it. */
export type FileView = { lines: readonly string[]; symbols: SymbolEntry[] }

export type LeverOp =
  | { kind: 'write'; file: string }
  /** `slice` is a single-file Read asked with offset or limit; `range` the lines its result showed. */
  | { kind: 'read'; file: string; range: Range | null; slice: boolean; limit: number | null }
  /** A content-mode Grep: the line numbers of its match lines, by file. */
  | { kind: 'grep'; matches: ReadonlyMap<string, readonly number[]> }

/** One API call of a thread: how many tools its response carried, and what they read, searched and wrote, in order. */
export type LeverStep = { tools: number; ops: LeverOp[] }

/** What one mechanism adds up to; the header says what each count means. */
type LeverTally = { triggers: number; served: number; saved: number; repeats: number; returnedChars: number; servedChars: number }

type LeverCounts = {
  grep: LeverTally
  snap: LeverTally
  whole: LeverTally
  rangeReads: number
  /** The range Reads alone in their API call: the most calls a lever that serves reads could remove. */
  aloneRangeReads: number
  unresolvable: number
  unresolvableGreps: number
}

function emptyLeverCounts(): LeverCounts {
  const tally = (): LeverTally => ({ triggers: 0, served: 0, saved: 0, repeats: 0, returnedChars: 0, servedChars: 0 })
  return { grep: tally(), snap: tally(), whole: tally(), rangeReads: 0, aloneRangeReads: 0, unresolvable: 0, unresolvableGreps: 0 }
}

function matchesOfGrep(call: CensusCall): Map<string, number[]> | null {
  const result = call.result as { mode?: string; content?: unknown } | null
  // A search the tool answered as a symbol map (the auto-pivot) is not a content result.
  if (call.isError || call.input.output_mode !== 'content' || (result !== null && result.mode !== 'content')) return null
  const body = typeof result?.content === 'string' ? result.content : call.text
  // `N:text` with no path is a one-file search, or a run the regroup put under a `--- path ---` header.
  let current = typeof call.input.path === 'string' ? absolute(call.input.path, call.cwd) : null
  const matches = new Map<string, number[]>()
  const add = (file: string, line: string) => matches.set(file, [...(matches.get(file) ?? []), Number(line)])
  for (const line of body.split('\n')) {
    const header = GREP_HEADER_RE.exec(line)
    if (header) {
      current = absolute(header[1]!, call.cwd)
      continue
    }
    const pathless = current === null ? null : GREP_PATHLESS_RE.exec(line)
    if (pathless) {
      add(current!, pathless[1]!)
      continue
    }
    const match = GREP_MATCH_RE.exec(line)
    if (match) add(absolute(match[1]!, call.cwd), match[2]!)
  }
  return matches.size > 0 ? matches : null
}

/** A thread's API calls as the lever replay reads them. */
export function leverStepsOf(requests: readonly (readonly CensusCall[])[]): LeverStep[] {
  return requests.map(request => {
    const ops: LeverOp[] = []
    request.forEach((call, idx) => {
      for (const file of writesOf(call)) ops.push({ kind: 'write', file })
      const reads = call.tool === 'Read' ? readsOfRead(call, idx) : call.tool === 'Bash' ? readsOfBash(call, idx) : []
      const { offset, limit } = call.input
      const slice = reads.length === 1 && reads[0]!.kind === 'text' && (offset !== undefined || limit !== undefined)
      for (const read of reads) {
        ops.push({ kind: 'read', file: read.file, range: read.range, slice, limit: slice && limit !== undefined ? Number(limit) : null })
      }
      const matches = call.tool === 'Grep' ? matchesOfGrep(call) : null
      if (matches) ops.push({ kind: 'grep', matches })
    })
    return { tools: request.length, ops }
  })
}

function charsOf(view: FileView, [from, to]: Range): number {
  let chars = 0
  for (let line = from; line <= Math.min(to, view.lines.length); line++) chars += view.lines[line - 1]!.length + 1
  return chars
}

/** The bodies an eligible Grep would carry, by file; null when it would carry none, 'unresolvable' when a matched file is gone or shorter. */
function bodiesOfGrep(
  matches: ReadonlyMap<string, readonly number[]>,
  lookup: (path: string) => FileView | null,
): { byFile: Map<string, Range[]>; chars: number } | 'unresolvable' | null {
  for (const [file, lineNos] of matches) {
    const view = lookup(file)
    if (!view || lineNos.some(n => n > view.lines.length)) return 'unresolvable'
  }
  const byFile = new Map<string, Range[]>()
  let bodies = 0
  let chars = 0
  for (const [file, lineNos] of matches) {
    const view = lookup(file)!
    const spans = new Map<string, Range>()
    for (const n of lineNos) {
      const symbol = enclosingSymbol(view.symbols, n)
      if (symbol) spans.set(`${symbol.startLine}-${symbol.endLine}`, [symbol.startLine, symbol.endLine])
    }
    for (const span of spans.values()) {
      if (span[1] - span[0] + 1 > MAX_BODY_LINES) return null
      chars += charsOf(view, span)
    }
    bodies += spans.size
    if (spans.size > 0) byFile.set(file, [...spans.values()])
  }
  return bodies >= 1 && bodies <= GREP_MAX_BODIES && chars <= BODIES_BUDGET_CHARS ? { byFile, chars } : null
}

/**
 * The lines a small range would gain by snapping to its symbols. Every symbol
 * a line of the range sits in overlaps the range, so their union with it is
 * one run; a symbol is taken whole or not at all, the smallest first, so a
 * method is kept where its class would pass the cap.
 */
function snapExtras(view: FileView, [from, to]: Range): Range[] {
  const spans = new Map<string, Range>()
  for (let line = from; line <= to; line++) {
    const symbol = enclosingSymbol(view.symbols, line)
    if (symbol) spans.set(`${symbol.startLine}-${symbol.endLine}`, [symbol.startLine, symbol.endLine])
  }
  let first = from
  let last = to
  for (const [start, end] of [...spans.values()].sort((a, b) => a[1] - a[0] - (b[1] - b[0]))) {
    const grown: Range = [Math.min(first, start), Math.max(last, end)]
    if (from - grown[0] + (grown[1] - to) > SNAP_MAX_EXTRA_LINES) continue
    first = grown[0]
    last = grown[1]
  }
  const extras: Range[] = []
  if (first < from) extras.push([first, from - 1])
  if (last > to) extras.push([to + 1, last])
  return extras
}

/**
 * Replays the three levers over one thread. Each is replayed alone, against
 * the reads the thread really made: a Read a lever serves is not made, so it
 * triggers nothing for that lever, and a Read the thread's own earlier reads
 * already covered is a repeat no lever is credited for.
 */
export function replayLevers(
  steps: readonly LeverStep[],
  lookup: (path: string) => FileView | null,
  into: LeverCounts = emptyLeverCounts(),
): LeverCounts {
  const seen = new Map<string, Range[]>()
  const snapped = new Map<string, Range[]>()
  const slices = new Map<string, Set<string>>()
  const whole = new Set<string>()
  let offers: { from: number; bodies: Map<string, Range[]> }[] = []
  steps.forEach((step, at) => {
    offers = offers.filter(offer => at <= offer.from + GREP_REACH_CALLS)
    const alone = step.tools === 1
    /** True when the lever made this read unnecessary; a repeat is counted and stays a real read. */
    const serve = (tally: LeverTally, coveredByLever: boolean, repeat: boolean, chars: number): boolean => {
      if (!coveredByLever) return false
      if (repeat) {
        tally.repeats++
        return false
      }
      tally.served++
      tally.servedChars += chars
      if (alone) tally.saved++
      return true
    }
    for (const op of step.ops) {
      if (op.kind === 'write') {
        for (const state of [seen, snapped, slices, whole, ...offers.map(offer => offer.bodies)]) state.delete(op.file)
        continue
      }
      if (op.kind === 'grep') {
        const bodies = bodiesOfGrep(op.matches, lookup)
        if (bodies === 'unresolvable') into.unresolvableGreps++
        else if (bodies) {
          into.grep.triggers++
          into.grep.returnedChars += bodies.chars
          offers.push({ from: at, bodies: bodies.byFile })
        }
        continue
      }
      const real = seen.get(op.file) ?? []
      const range = op.range
      if (op.slice && range) {
        const view = lookup(op.file)
        if (!view || range[1] > view.lines.length) into.unresolvable++
        else {
          into.rangeReads++
          if (alone) into.aloneRangeReads++
          const repeat = covered(range, real)
          const chars = charsOf(view, range)
          serve(into.grep, offers.some(offer => offer.from < at && covered(range, offer.bodies.get(op.file) ?? [])), repeat, chars)

          const extras = snapped.get(op.file) ?? []
          if (!serve(into.snap, covered(range, [...real, ...extras]), repeat, chars) && op.limit !== null && op.limit <= SNAP_MAX_LIMIT) {
            const gained = snapExtras(view, range)
            if (gained.length > 0) {
              into.snap.triggers++
              for (const extra of gained) into.snap.returnedChars += charsOf(view, extra)
              snapped.set(op.file, [...extras, ...gained])
            }
          }

          if (!whole.has(op.file)) {
            const ranges = slices.get(op.file) ?? new Set<string>()
            slices.set(op.file, ranges.add(`${range[0]}-${range[1]}`))
            const fileChars = charsOf(view, WHOLE)
            if (ranges.size >= WHOLE_FROM_SLICE && view.lines.length <= WHOLE_MAX_LINES && fileChars <= WHOLE_MAX_CHARS) {
              into.whole.triggers++
              into.whole.returnedChars += fileChars - chars
              whole.add(op.file)
            }
          } else serve(into.whole, true, repeat, chars)
        }
      }
      if (range) seen.set(op.file, [...real, range])
    }
  })
  return into
}

/** The pre-registered gate: saved calls at 2% of the main API calls or more, and a positive net. */
export function leverVerdict(
  tally: LeverTally,
  mainCalls: number,
  callUsd: number,
  writeUsdPerMtok: number,
): { addedChars: number; addedTokens: number; netUsd: number; pass: boolean; why: string } {
  const addedChars = tally.returnedChars - tally.servedChars
  const addedTokens = Math.round(addedChars / 4)
  const netUsd = tally.saved * callUsd - (addedTokens * writeUsdPerMtok) / 1e6
  const failed = [
    ...(mainCalls > 0 && tally.saved >= PASS_SHARE * mainCalls ? [] : [`saved calls ${pct(tally.saved, mainCalls)} of main API calls, under ${PASS_SHARE * 100}%`]),
    ...(netUsd > 0 ? [] : [`net $${netUsd.toFixed(2)}, not above 0`]),
  ]
  return { addedChars, addedTokens, netUsd, pass: failed.length === 0, why: failed.join('; ') }
}

/**
 * One transcript as calls, flat and by API call: assistant records sharing a
 * `message.id` are one response, counted even when it carried no tool.
 * Records are bounded by `sinceMs`; tool_use and message ids already counted
 * elsewhere are skipped. `mainOnly` leaves `isSidechain` records out.
 */
function walkTranscript(
  path: string,
  sinceMs: number,
  seenIds: Set<string>,
  mainOnly = false,
): { calls: CensusCall[]; requests: CensusCall[][] } {
  const calls: CensusCall[] = []
  const byId = new Map<string, CensusCall>()
  const requests = new Map<string, CensusCall[]>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let record: Block
    try {
      record = JSON.parse(line) as Block
    } catch {
      continue
    }
    const ts = Date.parse(String(record.timestamp ?? ''))
    if (!(ts >= sinceMs)) continue
    if (mainOnly && record.isSidechain === true) continue
    const message = record.message as { content?: unknown; id?: unknown; model?: unknown } | undefined
    if (!Array.isArray(message?.content)) continue
    let request: CensusCall[] | undefined
    if (record.type === 'assistant' && message.model !== '<synthetic>') {
      const id = String(message.id ?? record.uuid ?? '')
      request = requests.get(id)
      if (!request && id && !seenIds.has(id)) {
        seenIds.add(id)
        request = []
        requests.set(id, request)
      }
    }
    for (const block of message.content as Block[]) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && !seenIds.has(block.id)) {
        seenIds.add(block.id)
        const call: CensusCall = {
          tool: String(block.name), input: (block.input ?? {}) as Block, text: '', isError: false,
          result: null, ts, cwd: String(record.cwd ?? ''), refreshed: [],
        }
        byId.set(block.id, call)
        calls.push(call)
        request?.push(call)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = byId.get(block.tool_use_id)
        if (!call) continue
        call.text = contentText(block.content)
        call.isError = block.is_error === true
        call.result = (record.toolUseResult && typeof record.toolUseResult === 'object' ? record.toolUseResult : null) as Block | null
        const refreshed = record.refreshedFiles
        if (Array.isArray(refreshed)) call.refreshed = refreshed.filter((p): p is string => typeof p === 'string')
      }
    }
  }
  return { calls, requests: [...requests.values()] }
}

/** One transcript as calls, records bounded by `sinceMs`; tool_use ids already counted elsewhere are skipped. */
export function callsOfTranscript(path: string, sinceMs: number, seenIds: Set<string>): CensusCall[] {
  return walkTranscript(path, sinceMs, seenIds).calls
}

/** The files the replay will ask for, read and scanned once; null for one that is gone or is not a file. */
async function loadViews(threads: readonly LeverStep[][]): Promise<Map<string, FileView | null>> {
  // Imported here so the census itself keeps running without the preload.
  const { scanFile } = await import('src/tools/FileReadTool/outlineView.js')
  const signal = new AbortController().signal
  const views = new Map<string, FileView | null>()
  const paths = threads.flat().flatMap(step => step.ops).flatMap(op =>
    op.kind === 'grep' ? [...op.matches.keys()] : op.kind === 'read' && op.slice && op.range ? [op.file] : [])
  for (const path of new Set(paths)) {
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      views.set(path, null)
      continue
    }
    // The line count Read reports: a trailing newline does not open a line (as `scanFile` has it).
    const lines = source.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const lang = detectOutlineLangFromPath(path)
    const scanned = lang ? await scanFile(path, lang, signal) : null
    views.set(path, { lines, symbols: scanned?.entries ?? [] })
  }
  return views
}

async function levers(paths: readonly string[], sinceMs: number, callUsd: number, writeUsd: number): Promise<void> {
  const seenIds = new Set<string>()
  const threads = paths.map(path => leverStepsOf(walkTranscript(path, sinceMs, seenIds, true).requests))
  const views = await loadViews(threads)
  const counts = emptyLeverCounts()
  for (const steps of threads) replayLevers(steps, path => views.get(path) ?? null, counts)
  const mainCalls = threads.reduce((n, steps) => n + steps.length, 0)
  console.log(`# Read-lever replay since ${new Date(sinceMs).toISOString().slice(0, 10)} — ${paths.length} main transcripts`)
  console.log(`\n${String(mainCalls).padStart(6)}  main API calls`)
  console.log(`${String(counts.rangeReads).padStart(6)}  range Reads replayed`)
  console.log(`${String(counts.aloneRangeReads).padStart(6)}  of them alone in their API call (${pct(counts.aloneRangeReads, mainCalls)} of the calls): the most a lever could save`)
  console.log(`${String(counts.unresolvable).padStart(6)}  range Reads unresolvable (file gone, or shorter than the range)`)
  console.log(`${String(counts.unresolvableGreps).padStart(6)}  content Greps unresolvable (a matched file gone or shorter)`)
  console.log(`\none saved call = $${callUsd}; one added token = $${writeUsd}/M`)
  const rows = [
    ['A grep bodies', counts.grep],
    ['B range → symbol', counts.snap],
    ['C whole on 3rd', counts.whole],
  ] as const
  const columns = ['triggers', 'served', 'saved', '% calls', 'repeats', 'returned', 'added ch', 'added tok', 'net $']
  console.log(`\n${'mechanism'.padEnd(18)}${columns.map(c => padLeft(c, 11)).join('')}`)
  const verdicts: string[] = []
  for (const [label, tally] of rows) {
    const verdict = leverVerdict(tally, mainCalls, callUsd, writeUsd)
    const cells = [
      tally.triggers, tally.served, tally.saved, pct(tally.saved, mainCalls), tally.repeats,
      tally.returnedChars, verdict.addedChars, verdict.addedTokens, verdict.netUsd.toFixed(2),
    ]
    console.log(`${label.padEnd(18)}${cells.map(c => padLeft(String(c), 11)).join('')}`)
    verdicts.push(`${label}: ${verdict.pass ? 'PASS' : `FAIL (${verdict.why})`}`)
  }
  console.log(`\n${verdicts.join('\n')}`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const value = (flag: string) => argv.find(a => a.startsWith(`--${flag}=`))?.slice(flag.length + 3)
  const since = value('since')
  const exclude = argv.filter(a => a.startsWith('--exclude=')).map(a => a.slice('--exclude='.length))
  const sinceMs = since ? Date.parse(since) : Date.now() - 7 * 24 * HOUR_MS
  const callUsd = Number(value('call-usd') ?? DEFAULT_CALL_USD)
  const writeUsd = Number(value('write-usd') ?? DEFAULT_WRITE_USD_PER_MTOK)
  const known = (a: string) => a === '--levers' || ['--since=', '--exclude=', '--call-usd=', '--write-usd='].some(flag => a.startsWith(flag))
  if ([sinceMs, callUsd, writeUsd].some(Number.isNaN) || !argv.every(known)) {
    console.error('usage: reread-census.ts [--since=YYYY-MM-DD] [--exclude=<session-prefix>] [--levers [--call-usd=N] [--write-usd=N]]')
    process.exit(2)
  }
  const dirs = projectDirs().filter(dir => !dir.slice(join(configDir(), 'projects').length + 1).startsWith('-tmp'))
  const files = transcriptFiles(dirs)
    .filter(t => t.mtimeMs >= sinceMs && !exclude.some(prefix => t.path.includes(prefix)))
    // Main threads first, so a call mirrored into a fork's transcript counts once, as the parent's.
    .sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent))
  if (argv.includes('--levers')) return levers(files.filter(t => !t.isSubagent).map(t => t.path), sinceMs, callUsd, writeUsd)
  const seenIds = new Set<string>()
  const counts = { main: {} as RereadCounts, sub: {} as RereadCounts }
  for (const file of files) rereadsOfThread(callsOfTranscript(file.path, sinceMs, seenIds), file.isSubagent ? counts.sub : counts.main)
  console.log(`# Re-read census since ${new Date(sinceMs).toISOString().slice(0, 10)} — ${files.length} transcripts`)
  for (const thread of ['main', 'sub'] as const) {
    console.log(`\n## ${thread === 'main' ? 'Main threads' : 'Sub-agents'}`)
    for (const [key, n] of Object.entries(counts[thread]).sort()) console.log(`${String(n).padStart(6)}  ${key}`)
  }
}

if (import.meta.main) await main()
