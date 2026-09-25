#!/usr/bin/env bun
/**
 * Do cut tool results cost requests? For every result a cut touched — the Bash
 * floor cap, the tool-result summarizer, Grep/Glob pagination, a persisted
 * output, a Read head-tail — how often the next requests only re-ran the cut
 * command or re-read what it had read, against the same rate after an UNCUT
 * result of the same tool and size. Reads transcripts only; spends nothing.
 *
 *   bun scripts/bench/tokens/cut-refetch-census.ts [--since=YYYY-MM-DD] [--bound]
 *
 * A "pure recovery" request comes within three requests of the cut, with no
 * edit in between, and every tool call in it re-runs the cut command (the same
 * command, or one naming no path it did not) or reads only files the cut
 * command itself had read. Reading a file the result merely listed is not one:
 * that is what a grep is for, cut or not.
 *
 * First run 2026-09-25 over 09-14..25 (team memory
 * `cut-results-request-cost-2026-09-25`): ~0.3% of requests; the summarizer
 * none; the cap on reads the model had already bounded, in sub-agents, the
 * one leak. `--bound` replays that fix (lineBound.ts, CLAUDIN_CAP_KEEP_BOUNDED)
 * over every capped Bash result, against a regex taxonomy the grammar did not
 * define, and fails if the rule keeps any whole-file dump, listing or other
 * producer piped into a bound. How much of the reads it keeps is reported, not
 * gated: the plan's gate (≥80% of the capped range reads and searches into a
 * bound of at most 150 lines) came out at 30% on 2026-09-25, and 42% once the
 * grammar took bare `head`, literal `for` loops, `$DIR/path` and line filters
 * after the bound, because most of that class chains the bounded read with an
 * unbounded part — a `grep -r` with no limit, an `ls`, a `cat` — which the
 * rule must not keep. It keeps the results behind 53% of the recoveries that
 * followed those shapes. The date
 * defaults to 14 days back; `/tmp` projects (the A/B benches) are left out.
 *
 * Run it with the test preload, which stubs what the imports reach outside
 * the bundle, and NODE_ENV=test, which lets getGlobalConfig() run outside the
 * app's boot:
 *
 *   NODE_ENV=test bun --preload ./src/stubs/test-preload.ts \
 *     scripts/bench/tokens/cut-refetch-census.ts --since=2026-09-14 --bound
 */
import { readFileSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import { BOUNDED_READ_MAX_LINES } from 'src/tools/shared/outputFilter/Bash/floor.js'
import { commandLineBound } from 'src/tools/shared/outputFilter/Bash/lineBound.js'
import { configDir, contentText, pct, transcriptFiles, type Block } from './transcriptCorpus'

type Use = { id: string; name: string; input: Block; result: string; hasResult: boolean }
type Thread = { cwd: string; requests: Use[][]; isSubagent: boolean }

const argv = process.argv.slice(2)
const SINCE_ARG = argv.find(a => a.startsWith('--since='))?.slice('--since='.length)
const BOUND = argv.includes('--bound')
const DAY_MS = 24 * 60 * 60 * 1000
const since = SINCE_ARG ? Date.parse(SINCE_ARG) : Date.now() - 14 * DAY_MS
if (Number.isNaN(since) || argv.some(a => a !== '--bound' && !a.startsWith('--since='))) {
  console.error('usage: cut-refetch-census.ts [--since=YYYY-MM-DD] [--bound]')
  process.exit(2)
}
/** How many requests after a cut may still be answering it. */
const WINDOW = 3

const isRecord = (v: unknown): v is Block => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One transcript as its requests: a request is one model response, its tool calls in order. */
function parseThread(path: string, isSubagent: boolean): Thread {
  const requests: Use[][] = []
  const byMessage = new Map<string, Use[]>()
  const byUse = new Map<string, Use>()
  let cwd = ''
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a partial last line of a live session
    }
    if (!isRecord(entry)) continue
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
    const message = entry.message
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    if (entry.type === 'assistant') {
      // One transcript line per content block, all sharing the message id.
      const id = String(message.id ?? entry.uuid)
      let request = byMessage.get(id)
      if (!request) {
        request = []
        byMessage.set(id, request)
        requests.push(request)
      }
      for (const block of message.content.filter(isRecord)) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string' || byUse.has(block.id)) continue
        const use: Use = { id: block.id, name: String(block.name), input: isRecord(block.input) ? block.input : {}, result: '', hasResult: false }
        request.push(use)
        byUse.set(block.id, use)
      }
    } else if (entry.type === 'user') {
      for (const block of message.content.filter(isRecord)) {
        const use = block.type === 'tool_result' ? byUse.get(String(block.tool_use_id)) : undefined
        if (!use) continue
        use.result = contentText(block.content)
        use.hasResult = true
      }
    }
  }
  return { cwd, requests, isSubagent }
}

// ---------------------------------------------------------------------------
// What was cut, and the uncut baseline
// ---------------------------------------------------------------------------

const STRATEGY_RE = /strategy="([^"]+)"/
const CAP_RE = /lines omitted…/
const READ_HEAD_TAIL_RE = /… [\d,]+ lines omitted …/
const TRUNCATED_RE = /characters truncated|lines truncated/
const LINES_ATTR_RE = /lines="(\d+)\/(\d+)"/

function cutOf(u: Use): string | null {
  if (!u.hasResult) return null
  const r = u.result
  if (r.startsWith('<tool-result-summary')) return `summarizer:${u.name}:${STRATEGY_RE.exec(r)?.[1] ?? '?'}`
  if (r.includes('<persisted-output>')) return `persisted:${u.name}`
  if ((u.name === 'Bash' || u.name === 'Git') && CAP_RE.test(r)) return `cap:${u.name}`
  if (TRUNCATED_RE.test(r)) return `truncated:${u.name}`
  if (u.name === 'Read' && READ_HEAD_TAIL_RE.test(r)) return 'read:head-tail'
  if (u.name === 'Grep' && r.includes('pagination =')) return 'grep:paged'
  return null
}

function baselineOf(u: Use): string | null {
  if (!u.hasResult || cutOf(u)) return null
  const lines = u.result.split('\n').length
  if (u.name === 'Bash' && lines > 20) return lines > 60 ? 'uncut Bash >60 lines' : 'uncut Bash 21-60 lines'
  if (u.name === 'Grep' && u.result.length > 3000) return 'uncut Grep >3k'
  if (u.name === 'Read' && lines > 150) return 'uncut Read >150 lines'
  return null
}

const RANGE_RE = /\bsed\s+-n\b|\bawk\s+'NR|\bhead\s+-n?\s*\d+\s+\S|\btail\s+-n?\s*\d+\s+\S/
const PIPE_BOUND_RE = /\|\s*(?:head\s+-n?\s*\d+|tail\s+-n?\s*\d+|sed\s+-n|awk\s+'NR)/
const SEARCH_RE = /\b(?:grep|rg)\b/
/** A file's text piped into the bound: `cat f |`, `git show rev:path |`, a range print feeding another. */
const FILE_PRINT_FEED_RE = /(?:^|[;&]\s*)(?:cat|nl|sed|awk|head|tail|git\s+show\s+\S+:\S+)\b[^;&|]*\|/
const QUOTED_RE = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const CAT_RE = /(?:^|[;&|]\s*|\bdo\s+)cat\s+[^|<>]*\S/
const LISTING_RE = /\b(?:ls|find|git ls-files|tree|du|wc -l)\b/

/**
 * What a capped command was, by regex and independently of lineBound.ts's
 * grammar — so the replay's gates compare the grammar against something it
 * did not define.
 */
function capShape(command: string): string {
  if (PIPE_BOUND_RE.test(command)) {
    if (SEARCH_RE.test(command)) return 'search into a bound'
    // A sed script's `;` must not read as the end of a segment.
    return FILE_PRINT_FEED_RE.test(command.replace(QUOTED_RE, "''")) ? 'file print into a bound' : 'other pipe into a bound'
  }
  if (RANGE_RE.test(command)) return 'range read'
  if (CAT_RE.test(command)) return 'whole-file dump'
  if (LISTING_RE.test(command) && !SEARCH_RE.test(command)) return 'listing'
  if (SEARCH_RE.test(command)) return 'search'
  return 'other'
}

// ---------------------------------------------------------------------------
// What a later call does about it
// ---------------------------------------------------------------------------

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Patch', 'apply_patch'])
const BASH_WRITE_RE = /\bsed\s+-[a-zA-Z]*i|\bperl\s+-[a-zA-Z]*i|(?:^|[^2&])>\s*[\w./-]+\.(?:ts|tsx|js|json|md)\b|\btee\b/
const REDUCER_TAIL_RE = /(?:\s*\|\s*(?:head|tail|sed -n|grep|rg|wc|sort|uniq|cut|awk|cat|nl|less)\b[^|]*)+$/
const CD_PREFIX_RE = /^cd\s+\S+\s*&&\s*/
const MERGE_STDERR_RE = / 2>&1/g
const WS_RE = /\s+/g
const TOKEN_SPLIT_RE = /[\s|;&()<>]+/
const QUOTES_RE = /^['"]|['"]$/g
const TRAILING_SLASH_RE = /\/+$/
const READERS = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'less', 'bat', 'wc', 'grep', 'rg'])
const PATHISH_RE = /^[\w@.~+\-/]*[\w-]\.[A-Za-z]\w*$|\//

const commandsOf = (u: Use): string[] =>
  u.name === 'Bash' ? [String(u.input.command ?? '')] : u.name === 'Git' && Array.isArray(u.input.commands) ? u.input.commands.map(String) : []
/** A command with its `cd` prefix, stderr merge and trailing reducers stripped. */
const signature = (c: string): string =>
  c.trim().replace(WS_RE, ' ').replace(CD_PREFIX_RE, '').replace(MERGE_STDERR_RE, '').replace(REDUCER_TAIL_RE, '').trim()
const program = (c: string): string => signature(c).split(' ').slice(0, 2).join(' ')

function absolute(p: string, cwd: string): string {
  const s = p.replace(QUOTES_RE, '').replace(TRAILING_SLASH_RE, '')
  return normalize(isAbsolute(s) ? s : join(cwd, s))
}

/** Every path a call names: Read/Grep inputs, and path-shaped words of its commands. */
function namedPaths(u: Use, cwd: string): string[] {
  const out: string[] = []
  const { file_path, file_paths, path } = u.input
  if (typeof file_path === 'string') out.push(file_path)
  if (Array.isArray(file_paths)) out.push(...file_paths.filter((p): p is string => typeof p === 'string'))
  if (typeof path === 'string') out.push(path)
  for (const c of commandsOf(u)) {
    for (const t of c.split(TOKEN_SPLIT_RE)) if (t && PATHISH_RE.test(t) && !t.startsWith('-') && !t.includes('://')) out.push(t)
  }
  return [...new Set(out.map(p => absolute(p, cwd)))]
}

/** The files a call reads: a Read, a Grep over a path, a Bash reader. */
function readPaths(u: Use, cwd: string): string[] {
  if (u.name === 'Read' || u.name === 'Grep') return namedPaths(u, cwd)
  if (u.name !== 'Bash') return []
  const words = signature(String(u.input.command ?? '')).split(TOKEN_SPLIT_RE).filter(Boolean)
  if (!READERS.has(words[0] ?? '')) return []
  return words.slice(1).filter(t => PATHISH_RE.test(t) && !t.startsWith('-')).map(t => absolute(t, cwd))
}

const isEdit = (u: Use): boolean => EDIT_TOOLS.has(u.name) || (u.name === 'Bash' && BASH_WRITE_RE.test(String(u.input.command ?? '')))

/** Whether `v` only recovers what `u` showed: the same command again, or a read of what `u` read. */
function recovers(u: Use, v: Use, cwd: string, named: readonly string[]): boolean {
  const uc = commandsOf(u)
  const vc = commandsOf(v)
  if (uc.length && vc.length) {
    if (uc.some(a => signature(a) && vc.some(b => signature(a) === signature(b)))) return true
    const onlyNamed = namedPaths(v, cwd).every(p => named.includes(p))
    if (onlyNamed && uc.some(a => program(a) && vc.some(b => program(a) === program(b)))) return true
  }
  if (u.name === 'Grep' && v.name === 'Grep' && v.input.pattern === u.input.pattern) return true
  const reads = readPaths(v, cwd)
  if (!reads.length) return false
  if (u.result.includes('<persisted-output>') && reads.some(p => p.includes('tool-results'))) return true
  return reads.every(p => named.includes(p))
}

/** Whether a request within WINDOW after `k` holds nothing but recoveries of `u`. */
function recoveredBy(t: Thread, k: number, u: Use): boolean {
  const named = namedPaths(u, t.cwd)
  for (let j = k + 1; j <= Math.min(k + WINDOW, t.requests.length - 1); j++) {
    const request = t.requests[j]!
    // An edit in between makes a later run a check, not a recovery.
    if (request.some(isEdit)) return false
    if (request.length > 0 && request.every(v => recovers(u, v, t.cwd, named))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

type Tally = { n: number; recovered: number }
type Capped = { command: string; originalLines: number; recovered: boolean; isSubagent: boolean }

const tallies = { main: new Map<string, Tally>(), sub: new Map<string, Tally>() }
const requests = { main: 0, sub: 0 }
const capped: Capped[] = []

const root = join(configDir(), 'projects')
const files = transcriptFiles([root]).filter(f => f.mtimeMs >= since && !f.path.slice(root.length + 1).startsWith('-tmp'))
for (const file of files) {
  const t = parseThread(file.path, file.isSubagent)
  const kind = t.isSubagent ? 'sub' : 'main'
  requests[kind] += t.requests.length
  t.requests.forEach((request, k) => {
    for (const u of request) {
      const cut = cutOf(u)
      const cls = cut ?? baselineOf(u)
      if (!cls) continue
      const recovered = recoveredBy(t, k, u)
      const tally = tallies[kind].get(cls) ?? { n: 0, recovered: 0 }
      tally.n++
      if (recovered) tally.recovered++
      tallies[kind].set(cls, tally)
      if (cut === 'cap:Bash') {
        const originalLines = Number(LINES_ATTR_RE.exec(u.result)?.[2] ?? 0)
        capped.push({ command: String(u.input.command ?? ''), originalLines, recovered, isSubagent: t.isSubagent })
      }
    }
  })
}

console.log(`# Cut results and the requests after them — since ${new Date(since).toISOString().slice(0, 10)}, ${files.length} transcripts`)
for (const kind of ['main', 'sub'] as const) {
  console.log(`\n## ${kind === 'main' ? 'Main threads' : 'Sub-agents'} — ${requests[kind]} requests`)
  console.log('| result | n | pure recovery within 3 requests |')
  console.log('|---|---|---|')
  const rows = [...tallies[kind]].sort(([a, x], [b, y]) => Number(a.startsWith('uncut')) - Number(b.startsWith('uncut')) || y.n - x.n)
  for (const [cls, { n, recovered }] of rows) console.log(`| ${cls} | ${n} | ${pct(recovered, n)} (${recovered}) |`)
}

// ---------------------------------------------------------------------------
// --bound: replay lineBound.ts over every capped Bash result
// ---------------------------------------------------------------------------

if (BOUND) {
  const kept = (c: Capped): boolean => {
    if (c.originalLines > BOUNDED_READ_MAX_LINES) return false
    const bound = commandLineBound(c.command)
    return bound !== null && bound <= BOUNDED_READ_MAX_LINES
  }
  const byShape = new Map<string, { n: number; small: number; kept: number; recovered: number; recoveredKept: number }>()
  for (const c of capped) {
    const shape = capShape(c.command)
    const row = byShape.get(shape) ?? { n: 0, small: 0, kept: 0, recovered: 0, recoveredKept: 0 }
    row.n++
    if (c.originalLines <= BOUNDED_READ_MAX_LINES) row.small++
    const k = kept(c)
    if (k) row.kept++
    if (c.recovered) row.recovered++
    if (c.recovered && k) row.recoveredKept++
    byShape.set(shape, row)
  }
  console.log(`\n## --bound: what the rule keeps whole of the ${capped.length} capped Bash results`)
  console.log(`| shape (regex, not the grammar) | capped | ≤${BOUNDED_READ_MAX_LINES} lines | kept whole | recovered after | of those, now kept |`)
  console.log('|---|---|---|---|---|---|')
  for (const [shape, r] of [...byShape].sort(([, a], [, b]) => b.n - a.n)) {
    console.log(`| ${shape} | ${r.n} | ${r.small} | ${r.kept} (${pct(r.kept, r.small)}) | ${r.recovered} | ${r.recoveredKept} |`)
  }
  const sum = (shapes: string[], key: 'small' | 'kept' | 'recovered' | 'recoveredKept') =>
    shapes.reduce((s, sh) => s + (byShape.get(sh)?.[key] ?? 0), 0)
  const TARGET = ['range read', 'search into a bound', 'file print into a bound']
  const NEVER = ['whole-file dump', 'listing', 'other pipe into a bound']
  const leaked = sum(NEVER, 'kept')
  console.log('')
  console.log(`kept ${pct(sum(TARGET, 'kept'), sum(TARGET, 'small'))} of the range reads, searches and file prints into a bound ≤${BOUNDED_READ_MAX_LINES} lines`)
  console.log(`the results behind ${pct(sum(TARGET, 'recoveredKept'), sum(TARGET, 'recovered'))} of the recoveries after them are now kept whole`)
  console.log(`${leaked === 0 ? 'PASS' : 'FAIL'}  keeps none of the whole-file dumps, listings and other pipes into a bound: ${leaked}`)
  if (leaked > 0) process.exitCode = 1
}
