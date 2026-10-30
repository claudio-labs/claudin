#!/usr/bin/env bun
/**
 * Re-read census: how often a recorded session read a file it had already
 * read, with no write to it in between, and why.
 *
 *   bun scripts/bench/tokens/reread-census.ts [--since=YYYY-MM-DD] [--exclude=<session-prefix>]
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
 */
import { readFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { configDir, contentText, projectDirs, transcriptFiles, type Block } from './transcriptCorpus'

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

/** One transcript as calls, records bounded by `sinceMs`; tool_use ids already counted elsewhere are skipped. */
export function callsOfTranscript(path: string, sinceMs: number, seenIds: Set<string>): CensusCall[] {
  const calls: CensusCall[] = []
  const byId = new Map<string, CensusCall>()
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
    const message = record.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content as Block[]) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && !seenIds.has(block.id)) {
        seenIds.add(block.id)
        const call: CensusCall = {
          tool: String(block.name), input: (block.input ?? {}) as Block, text: '', isError: false,
          result: null, ts, cwd: String(record.cwd ?? ''), refreshed: [],
        }
        byId.set(block.id, call)
        calls.push(call)
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
  return calls
}

function main(): void {
  const argv = process.argv.slice(2)
  const since = argv.find(a => a.startsWith('--since='))?.slice('--since='.length)
  const exclude = argv.filter(a => a.startsWith('--exclude=')).map(a => a.slice('--exclude='.length))
  const sinceMs = since ? Date.parse(since) : Date.now() - 7 * 24 * HOUR_MS
  if (Number.isNaN(sinceMs) || argv.some(a => !a.startsWith('--since=') && !a.startsWith('--exclude='))) {
    console.error('usage: reread-census.ts [--since=YYYY-MM-DD] [--exclude=<session-prefix>]')
    process.exit(2)
  }
  const dirs = projectDirs().filter(dir => !dir.slice(join(configDir(), 'projects').length + 1).startsWith('-tmp'))
  const files = transcriptFiles(dirs)
    .filter(t => t.mtimeMs >= sinceMs && !exclude.some(prefix => t.path.includes(prefix)))
    // Main threads first, so a call mirrored into a fork's transcript counts once, as the parent's.
    .sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent))
  const seenIds = new Set<string>()
  const counts = { main: {} as RereadCounts, sub: {} as RereadCounts }
  for (const file of files) rereadsOfThread(callsOfTranscript(file.path, sinceMs, seenIds), file.isSubagent ? counts.sub : counts.main)
  console.log(`# Re-read census since ${new Date(sinceMs).toISOString().slice(0, 10)} — ${files.length} transcripts`)
  for (const thread of ['main', 'sub'] as const) {
    console.log(`\n## ${thread === 'main' ? 'Main threads' : 'Sub-agents'}`)
    for (const [key, n] of Object.entries(counts[thread]).sort()) console.log(`${String(n).padStart(6)}  ${key}`)
  }
}

if (import.meta.main) main()
