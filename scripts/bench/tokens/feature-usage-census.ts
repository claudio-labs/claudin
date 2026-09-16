/**
 * Feature-usage census: how the context-relief features were actually used
 * over a date window of recorded sessions.
 *
 *   - Bash output filter — calls / blocked (redirects) / ran, the marker mix
 *     (filtered / rewritten / persisted / raw), reduction distribution and the
 *     estimated chars saved, the heads that produced the biggest RAW results
 *     (the gap), and the anomalies worth a look: a body with MORE lines than
 *     the original, a listing command that had lines omitted, a marginal
 *     reduction that cost more wrapper than it saved.
 *   - Grep output modes — explicit `output_mode` mix, `head_limit` / context /
 *     `path` scoping, the auto-pivot to the symbol map and whether the model
 *     took its hint, `files_with_matches` → `content` re-runs of one pattern.
 *   - Read shape — outline / symbol / range / full, the auto-outline pivot and
 *     what the model did NEXT on the same file (symbol / range / full / nothing),
 *     re-reads of one path, and the large full bodies that never pivoted.
 *
 * Same walk discipline as session-census.ts: recurses into
 * `<session>/subagents/`, dedupes tool uses by id (a fork mirrors its parent's
 * history), pairs tool_use ↔ tool_result by id, and reports calls / blocked /
 * ran rather than raw grep hits. Transcripts are DATA: only aggregates, command
 * HEADS and basenames are printed.
 *
 * Run:
 *   bun scripts/bench/tokens/feature-usage-census.ts --since=2026-09-14 --until=2026-09-15
 *   bun scripts/bench/tokens/feature-usage-census.ts --since=2026-09-14 --exclude=<sessionId> --json
 */
import { readFileSync } from 'fs'
import { basename, dirname } from 'path'
import {
  contentText,
  pad,
  padLeft,
  pct,
  projectDirs,
  transcriptFiles,
  type Block,
} from './transcriptCorpus.js'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Args = {
  since: string
  until: string
  project: string | null
  exclude: Set<string>
  json: boolean
}

function localDate(ts: number): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | null => {
    const hit = argv.find(a => a.startsWith(`--${k}=`))
    return hit ? hit.slice(k.length + 3) : null
  }
  const today = localDate(Date.now())
  return {
    since: get('since') ?? today,
    until: get('until') ?? today,
    project: get('project'),
    exclude: new Set((get('exclude') ?? '').split(',').filter(Boolean)),
    json: argv.includes('--json'),
  }
}

function cwdSlug(): string {
  return process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

type Use = {
  id: string
  tool: string
  input: Block
  ts: number
  file: string
  session: string
  sub: boolean
  seq: number
}

type Call = Use & {
  text: string
  chars: number
  isError: boolean
  answered: boolean
}

function sessionOf(file: string): { session: string; sub: boolean } {
  const dir = dirname(file)
  if (basename(dir) === 'subagents') {
    return { session: basename(dirname(dir)), sub: true }
  }
  return { session: basename(file, '.jsonl'), sub: false }
}

function walk(files: readonly string[]): Call[] {
  const uses = new Map<string, Use>()
  const results = new Map<string, { text: string; isError: boolean }>()
  let seq = 0
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { session, sub } = sessionOf(file)
    for (const line of raw.split('\n')) {
      if (!line) continue
      let rec: Block
      try {
        rec = JSON.parse(line) as Block
      } catch {
        continue
      }
      const message = rec.message as Block | undefined
      const content = message?.content
      if (!Array.isArray(content)) continue
      const ts = Date.parse(String(rec.timestamp ?? ''))
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Block
        if (rec.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string') {
          if (uses.has(b.id)) continue
          uses.set(b.id, {
            id: b.id,
            tool: String(b.name ?? ''),
            input: (b.input as Block) ?? {},
            ts,
            file,
            session,
            sub,
            seq: seq++,
          })
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          if (results.has(b.tool_use_id)) continue
          results.set(b.tool_use_id, { text: contentText(b.content), isError: b.is_error === true })
        }
      }
    }
  }
  const calls: Call[] = []
  for (const u of uses.values()) {
    const r = results.get(u.id)
    calls.push({
      ...u,
      text: r?.text ?? '',
      chars: r?.text.length ?? 0,
      isError: r?.isError ?? false,
      answered: r !== undefined,
    })
  }
  return calls.sort((a, b) => a.seq - b.seq)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')
const kb = (n: number): string => `${(n / 1024).toFixed(1)}K`

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function bump<K>(m: Map<K, number>, k: K, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by)
}

function sortedEntries<K>(m: Map<K, number>): [K, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const BLOCKED_RE = /^(?:<tool_use_error>)?Blocked:/
const REDIRECT_TARGET_RE = /→\s*([A-Za-z_]+)\(/
const FILTERED_TAG_RE = /^<bash-output-filtered([^>]*)>([\s\S]*)<\/bash-output-filtered>\s*$/
const REWRITTEN_TAG_RE = /^<bash-output-rewritten([^>]*)>/
const PERSISTED_RE = /^<persisted-output/
const ATTR_RE = /(\w+)="([^"]*)"/g
const OMITTED_RE = /…(\d+) lines omitted…/g
const CD_PREFIX_RE = /^cd\s+\S+\s*&&\s*/
const ENV_PREFIX_RE = /^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s*;?\s*)+/
const SHAPE_RE = /\s(\|\|?|&&|;)\s/
const TWO_TOKEN_HEADS = new Set(['bun', 'npm', 'npx', 'pnpm', 'yarn', 'git', 'gh', 'docker', 'cargo', 'go', 'python', 'python3'])
const LISTING_HEADS = new Set(['ls', 'find', 'tree', 'du', 'wc'])

function commandHead(command: string): string {
  const c = command.trim().replace(CD_PREFIX_RE, '').replace(ENV_PREFIX_RE, '')
  const toks = c.split(/\s+/)
  const first = toks[0] ?? ''
  if (TWO_TOKEN_HEADS.has(first) && toks[1] && !toks[1].startsWith('-')) return `${first} ${toks[1]}`
  return first
}

/** The first line of a refusal, minus the tool_use_error wrapper — harness text, never output. */
function refusalLead(text: string): string {
  return text.replace(/^<tool_use_error>/, '').split('\n')[0]!.slice(0, 90)
}

type BashReport = ReturnType<typeof bashReport>

function bashReport(calls: Call[]) {
  const bash = calls.filter(c => c.tool === 'Bash')
  const blockedBy = new Map<string, number>()
  const unparsedLeads = new Map<string, number>()
  let blocked = 0
  let errors = 0
  let unanswered = 0
  const ran: Call[] = []
  for (const c of bash) {
    if (!c.answered) {
      unanswered++
      continue
    }
    if (BLOCKED_RE.test(c.text)) {
      blocked++
      const m = REDIRECT_TARGET_RE.exec(c.text)
      bump(blockedBy, m?.[1] ?? '(unparsed)')
      if (!m) bump(unparsedLeads, refusalLead(c.text))
      continue
    }
    if (c.isError) {
      errors++
      continue
    }
    ran.push(c)
  }

  // What the model did after a capped result (a body with `…N lines omitted…`):
  // re-sent the same command, asked again with a narrower shape, moved to a
  // dedicated tool, or went on. Looks at the next 3 calls in the same transcript.
  const afterCap = new Map<string, number>()
  const reaskHeads = new Map<string, number>()
  const cappedHeads = new Map<string, { n: number; orig: number; omitted: number }>()
  const nextCallsOf = (c: Call, k: number): Call[] => {
    const out: Call[] = []
    const start = calls.indexOf(c)
    for (let i = start + 1; i < calls.length && out.length < k; i++) {
      if (calls[i]!.file === c.file) out.push(calls[i]!)
    }
    return out
  }

  let filtered = 0
  let rewrittenOnly = 0
  let persisted = 0
  let raw = 0
  let rawChars = 0
  let filteredWrapped = 0
  let filteredBody = 0
  let filteredEstOriginal = 0
  const reductions: number[] = []
  const reductionBuckets = new Map<string, number>()
  const filteredHeads = new Map<string, { n: number; body: number; saved: number }>()
  const rawHeads = new Map<string, { n: number; chars: number; big: number; compound: number }>()
  const rewrites = new Map<string, number>()
  const anomalies = {
    moreLinesThanOriginal: [] as { head: string; lines: string }[],
    listingOmitted: [] as { head: string; omitted: number; lines: string }[],
    marginal: [] as { head: string; reduction: number; body: number }[],
  }
  const bigRaw: { head: string; chars: number; compound: boolean }[] = []

  for (const c of ran) {
    const command = String(c.input.command ?? '')
    const head = commandHead(command)
    const compound = SHAPE_RE.test(command.replace(CD_PREFIX_RE, ''))
    const text = c.text
    const fm = FILTERED_TAG_RE.exec(text)
    if (fm) {
      filtered++
      const attrs = new Map<string, string>()
      for (const m of fm[1]!.matchAll(ATTR_RE)) attrs.set(m[1]!, m[2]!)
      if (attrs.get('actual')) bump(rewrites, `${attrs.get('original') ?? '?'} → ${attrs.get('actual')}`)
      const body = fm[2]!
      const reduction = Number((attrs.get('reduction') ?? '0').replace('%', ''))
      const lines = attrs.get('lines') ?? ''
      const [bodyLines, origLines] = lines.split('/').map(Number)
      reductions.push(reduction)
      const bucket =
        reduction < 10 ? '<10%' : reduction < 30 ? '10-30%' : reduction < 50 ? '30-50%' : reduction < 75 ? '50-75%' : '75%+'
      bump(reductionBuckets, bucket)
      const est = reduction < 100 ? body.length / (1 - reduction / 100) : body.length
      filteredWrapped += text.length
      filteredBody += body.length
      filteredEstOriginal += est
      const fh = filteredHeads.get(head) ?? { n: 0, body: 0, saved: 0 }
      fh.n++
      fh.body += body.length
      fh.saved += est - body.length
      filteredHeads.set(head, fh)
      if (bodyLines !== undefined && origLines !== undefined && bodyLines > origLines) {
        anomalies.moreLinesThanOriginal.push({ head, lines })
      }
      const omitted = [...body.matchAll(OMITTED_RE)].reduce((s, m) => s + Number(m[1]), 0)
      if (omitted > 0 && LISTING_HEADS.has(head.split(' ')[0]!)) {
        anomalies.listingOmitted.push({ head, omitted, lines })
      }
      if (omitted > 0) {
        const ch = cappedHeads.get(head) ?? { n: 0, orig: 0, omitted: 0 }
        ch.n++
        ch.orig += origLines ?? 0
        ch.omitted += omitted
        cappedHeads.set(head, ch)
        const next = nextCallsOf(c, 3)
        const sameCmd = next.find(n => n.tool === 'Bash' && String(n.input.command ?? '') === command)
        // "Same target": a later Bash call with the same head that names one of
        // the original's path arguments VERBATIM (or is the original command
        // with a pipe appended) — the model asking again about the thing it
        // just lost the middle of, versus listing a sub-directory next.
        const targets = new Set(command.split(/\s+/).filter(t => t.includes('/') && !t.startsWith('-')))
        const sameTarget = next.find(
          n =>
            n.tool === 'Bash' &&
            n !== sameCmd &&
            commandHead(String(n.input.command ?? '')) === head &&
            (String(n.input.command ?? '').startsWith(command) ||
              String(n.input.command ?? '')
                .split(/\s+/)
                .some(t => targets.has(t))),
        )
        const sameHead = next.find(n => n.tool === 'Bash' && n !== sameCmd && n !== sameTarget && commandHead(String(n.input.command ?? '')) === head)
        const dedicated = next.find(n => n.tool === 'Glob' || n.tool === 'Grep' || n.tool === 'Read')
        if (sameCmd || sameTarget) bump(reaskHeads, head)
        bump(
          afterCap,
          sameCmd
            ? 're-sent same command'
            : sameTarget
              ? 'same head, same target'
              : sameHead
                ? 'same head, other target'
                : dedicated
                  ? `moved to ${dedicated.tool}`
                  : 'went on',
        )
      }
      if (reduction < 15) anomalies.marginal.push({ head, reduction, body: body.length })
      continue
    }
    if (REWRITTEN_TAG_RE.test(text)) {
      rewrittenOnly++
      const attrs = new Map<string, string>()
      for (const m of REWRITTEN_TAG_RE.exec(text)![1]!.matchAll(ATTR_RE)) attrs.set(m[1]!, m[2]!)
      bump(rewrites, `${attrs.get('original') ?? '?'} → ${attrs.get('actual') ?? '?'}`)
      continue
    }
    if (PERSISTED_RE.test(text)) {
      persisted++
      continue
    }
    raw++
    rawChars += c.chars
    const rh = rawHeads.get(head) ?? { n: 0, chars: 0, big: 0, compound: 0 }
    rh.n++
    rh.chars += c.chars
    if (c.chars >= 1024) rh.big++
    if (compound) rh.compound++
    rawHeads.set(head, rh)
    if (c.chars >= 1024) bigRaw.push({ head, chars: c.chars, compound })
  }

  return {
    calls: bash.length,
    unanswered,
    blocked,
    blockedBy: sortedEntries(blockedBy),
    unparsedLeads: sortedEntries(unparsedLeads),
    errors,
    ran: ran.length,
    filtered,
    rewrittenOnly,
    persisted,
    raw,
    rawChars,
    rawBig: bigRaw.length,
    rawBigChars: bigRaw.reduce((s, b) => s + b.chars, 0),
    rawBigCompound: bigRaw.filter(b => b.compound).length,
    filteredWrapped,
    filteredBody,
    filteredEstOriginal,
    reductionMedian: median(reductions),
    reductionBuckets: sortedEntries(reductionBuckets),
    filteredHeads: [...filteredHeads.entries()].sort((a, b) => b[1].saved - a[1].saved),
    rawHeads: [...rawHeads.entries()].sort((a, b) => b[1].chars - a[1].chars),
    rewrites: sortedEntries(rewrites),
    anomalies,
    cappedHeads: [...cappedHeads.entries()].sort((a, b) => b[1].n - a[1].n),
    afterCap: sortedEntries(afterCap),
    reaskHeads: sortedEntries(reaskHeads),
    bigRaw: bigRaw.sort((a, b) => b.chars - a.chars).slice(0, 12),
  }
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

const GREP_AUTO_PIVOT = 'Search matched broadly; returned the symbol map instead of matching lines'
const GREP_NO_MATCH_RE = /^No matches found/
const GREP_INCOMPLETE_RE = /INCOMPLETE/
const GREP_IGNORED_FALLBACK_RE = /excluded by \.gitignore|--no-ignore/
const GREP_PAGINATION_RE = /\[Showing results with pagination/

function grepMode(input: Block): string {
  return String(input.output_mode ?? 'files_with_matches')
}

function grepReport(calls: Call[]) {
  const grep = calls.filter(c => c.tool === 'Grep' && c.answered)
  const byMode = new Map<string, { n: number; chars: number; sizes: number[]; noMatch: number; errors: number }>()
  const byModeSub = new Map<string, number>()
  const byModeMain = new Map<string, number>()
  let withHeadLimit = 0
  let withHeadLimitZero = 0
  let withHeadLimitZeroChars = 0
  const headLimitZeroByMode = new Map<string, number>()
  let headLimitZeroContentBig = 0
  let headLimitZeroContentBigChars = 0
  let withContext = 0
  let withPath = 0
  let withGlobOrType = 0
  let withMultiline = 0
  let autoPivot = 0
  let explicitSymbols = 0
  let incomplete = 0
  let ignoredFallback = 0
  let paginated = 0
  let contentOver6k = 0
  let contentOver6kChars = 0
  let contentOver6kWithLimit = 0
  let contentOver6kWithContext = 0
  const contentOver6kLimits = new Map<string, number>()
  let contentNoScopeNoLimit = 0
  let contentNoScopeNoLimitChars = 0

  for (const c of grep) {
    const mode = grepMode(c.input)
    const m = byMode.get(mode) ?? { n: 0, chars: 0, sizes: [], noMatch: 0, errors: 0 }
    m.n++
    m.chars += c.chars
    m.sizes.push(c.chars)
    if (GREP_NO_MATCH_RE.test(c.text)) m.noMatch++
    if (c.isError) m.errors++
    byMode.set(mode, m)
    bump(c.sub ? byModeSub : byModeMain, mode)
    if (c.input.head_limit !== undefined) withHeadLimit++
    if (c.input.head_limit === 0) {
      withHeadLimitZero++
      withHeadLimitZeroChars += c.chars
      bump(headLimitZeroByMode, mode)
      if (mode === 'content' && c.chars > 6 * 1024) {
        headLimitZeroContentBig++
        headLimitZeroContentBigChars += c.chars
      }
    }
    if (c.input['-A'] !== undefined || c.input['-B'] !== undefined || c.input['-C'] !== undefined || c.input.context !== undefined) withContext++
    if (c.input.path !== undefined) withPath++
    if (c.input.glob !== undefined || c.input.type !== undefined) withGlobOrType++
    if (c.input.multiline === true) withMultiline++
    if (c.text.includes(GREP_AUTO_PIVOT)) autoPivot++
    if (mode === 'symbols') explicitSymbols++
    if (GREP_INCOMPLETE_RE.test(c.text)) incomplete++
    if (GREP_IGNORED_FALLBACK_RE.test(c.text) && !GREP_NO_MATCH_RE.test(c.text)) ignoredFallback++
    if (GREP_PAGINATION_RE.test(c.text)) paginated++
    if (mode === 'content' && c.chars > 6 * 1024) {
      contentOver6k++
      contentOver6kChars += c.chars
      if (c.input.head_limit !== undefined) contentOver6kWithLimit++
      bump(contentOver6kLimits, String(c.input.head_limit ?? 'unset'))
      if (c.input['-A'] !== undefined || c.input['-B'] !== undefined || c.input['-C'] !== undefined || c.input.context !== undefined) contentOver6kWithContext++
    }
    if (mode === 'content' && c.input.path === undefined && c.input.head_limit === undefined) {
      contentNoScopeNoLimit++
      contentNoScopeNoLimitChars += c.chars
    }
  }

  // Follow-ups: the next Grep in the same transcript with the same pattern.
  const transitions = new Map<string, number>()
  const contentRerunKinds = new Map<string, number>()
  let pivotThenHint = 0
  let pivotThenNothing = 0
  let pivotThenSame = 0
  const byFile = new Map<string, Call[]>()
  for (const c of grep) {
    const list = byFile.get(c.file) ?? []
    list.push(c)
    byFile.set(c.file, list)
  }
  for (const list of byFile.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!
      const pat = String(a.input.pattern ?? '')
      let next: Call | null = null
      for (let j = i + 1; j < list.length; j++) {
        if (String(list[j]!.input.pattern ?? '') === pat) {
          next = list[j]!
          break
        }
      }
      if (next) bump(transitions, `${grepMode(a.input)} → ${grepMode(next.input)}`)
      if (next && grepMode(a.input) === 'content' && grepMode(next.input) === 'content') {
        const ai = a.input
        const ni = next.input
        const kind =
          JSON.stringify(ai) === JSON.stringify(ni)
            ? 'identical'
            : ni.offset !== undefined && ni.offset !== ai.offset
              ? 'paged (offset)'
              : ni.path !== ai.path
                ? 'path changed'
                : ni.head_limit !== ai.head_limit
                  ? 'head_limit changed'
                  : ni.glob !== ai.glob || ni.type !== ai.type
                    ? 'glob/type changed'
                    : 'context/flags changed'
        bump(contentRerunKinds, kind)
      }
      if (a.text.includes(GREP_AUTO_PIVOT)) {
        if (!next) pivotThenNothing++
        else if (
          next.input.head_limit !== undefined ||
          (next.input.path !== undefined && next.input.path !== a.input.path) ||
          (next.input.glob !== undefined && next.input.glob !== a.input.glob)
        ) {
          pivotThenHint++
        } else pivotThenSame++
      }
    }
  }

  return {
    calls: grep.length,
    byMode: [...byMode.entries()].map(([mode, m]) => ({
      mode,
      n: m.n,
      chars: m.chars,
      median: median(m.sizes),
      noMatch: m.noMatch,
      errors: m.errors,
    })),
    byModeMain: sortedEntries(byModeMain),
    byModeSub: sortedEntries(byModeSub),
    withHeadLimit,
    withHeadLimitZero,
    withHeadLimitZeroChars,
    headLimitZeroByMode: sortedEntries(headLimitZeroByMode),
    headLimitZeroContentBig,
    headLimitZeroContentBigChars,
    withContext,
    withPath,
    withGlobOrType,
    withMultiline,
    autoPivot,
    explicitSymbols,
    incomplete,
    ignoredFallback,
    paginated,
    contentOver6k,
    contentOver6kChars,
    contentOver6kWithLimit,
    contentOver6kWithContext,
    contentOver6kLimits: sortedEntries(contentOver6kLimits),
    contentNoScopeNoLimit,
    contentNoScopeNoLimitChars,
    transitions: sortedEntries(transitions),
    contentRerunKinds: sortedEntries(contentRerunKinds),
    pivotThenHint,
    pivotThenSame,
    pivotThenNothing,
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Three leads render an outline: an explicit `view='outline'`, the size pivot
// ("is large — showing a structural outline") and the read-cap overflow
// ("exceeds the read cap — showing a structural outline").
const READ_OUTLINE_RE =
  /^<system-reminder>\n(?:Structural outline of '|File '[^']*' \(\d+ lines\) (?:is large|exceeds the read cap))/
const READ_OVERCAP_RE = /^<system-reminder>\nFile '[^']*' \(\d+ lines\) exceeds the read cap/
const READ_AUTO_PIVOT = 'File is large; returned outline instead of full body'
const READ_OUTLINE_LINES_RE = /^<system-reminder>\n[^\n]*?\((\d+) lines\)/

function readShape(input: Block): string {
  if (input.symbol !== undefined) return 'symbol'
  if (input.view === 'outline') return 'outline'
  if (input.offset !== undefined || input.limit !== undefined) return 'range'
  if (input.view === 'full') return 'full(explicit)'
  if (input.pages !== undefined) return 'pdf-pages'
  return 'full(default)'
}

function readReport(calls: Call[]) {
  const reads = calls.filter(c => c.tool === 'Read' && c.answered)
  const byShape = new Map<string, { n: number; chars: number; sizes: number[]; errors: number }>()
  const byShapeMain = new Map<string, number>()
  const byShapeSub = new Map<string, number>()
  let outlineResults = 0
  let overcap = 0
  let autoPivots = 0
  let autoPivotChars = 0
  let autoPivotSourceLines = 0
  let defaultOver10k = 0
  let defaultOver10kChars = 0
  const defaultOver10kExt = new Map<string, number>()
  const followAfterAuto = new Map<string, number>()
  const followAfterExplicit = new Map<string, number>()
  let outlineThenFullSameFile = 0
  let outlineThenFullChars = 0

  const byFile = new Map<string, Call[]>()
  for (const c of reads) {
    const shape = readShape(c.input)
    const s = byShape.get(shape) ?? { n: 0, chars: 0, sizes: [], errors: 0 }
    s.n++
    s.chars += c.chars
    s.sizes.push(c.chars)
    if (c.isError) s.errors++
    byShape.set(shape, s)
    bump(c.sub ? byShapeSub : byShapeMain, shape)
    if (READ_OUTLINE_RE.test(c.text)) outlineResults++
    if (READ_OVERCAP_RE.test(c.text)) overcap++
    if (c.text.includes(READ_AUTO_PIVOT)) {
      autoPivots++
      autoPivotChars += c.chars
      const m = READ_OUTLINE_LINES_RE.exec(c.text)
      if (m) autoPivotSourceLines += Number(m[1])
    }
    if (shape === 'full(default)' && c.chars > 10 * 1024 && !READ_OUTLINE_RE.test(c.text)) {
      defaultOver10k++
      defaultOver10kChars += c.chars
      const path = String(c.input.file_path ?? '')
      const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '(none)'
      bump(defaultOver10kExt, ext)
    }
    const list = byFile.get(c.file) ?? []
    list.push(c)
    byFile.set(c.file, list)
  }

  // Follow-up after an outline result, on the same path in the same transcript.
  let rereadPaths = 0
  let rereadExtraCalls = 0
  let rereadExtraChars = 0
  let distinctPaths = 0
  const rereadBasenames = new Map<string, { n: number; chars: number; shapes: Map<string, number> }>()
  // A slice-walk: 3+ range reads of one path with no outline/symbol read of it
  // before them. "Contiguous" is the subset where each next offset picks up
  // where the previous slice ended (±20 lines) — the re-read loop the
  // auto-outline exists to prevent, as opposed to Grep-driven jumps.
  let sliceWalks = 0
  let sliceWalkCalls = 0
  let sliceWalkChars = 0
  let contiguousWalks = 0
  let contiguousWalkCalls = 0
  let contiguousWalkChars = 0
  // An edit followed by a read of the same path later in the same transcript.
  let readAfterEdit = 0
  let readAfterEditChars = 0
  const editedAt = new Map<string, number[]>() // `${file}\u0000${path}` → seq of each write
  for (const c of calls) {
    if (c.tool !== 'Edit' && c.tool !== 'Write' && c.tool !== 'apply_patch') continue
    const paths: string[] = []
    if (typeof c.input.file_path === 'string') paths.push(c.input.file_path)
    if (typeof c.input.patchText === 'string') {
      for (const m of c.input.patchText.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)) paths.push(m[1]!.trim())
    }
    for (const p of paths) {
      const k = `${c.file}\u0000${p}`
      const l = editedAt.get(k) ?? []
      l.push(c.seq)
      editedAt.set(k, l)
    }
  }
  for (const list of byFile.values()) {
    const perPath = new Map<string, Call[]>()
    for (const c of list) {
      const p = String(c.input.file_path ?? '')
      const l = perPath.get(p) ?? []
      l.push(c)
      perPath.set(p, l)
    }
    distinctPaths += perPath.size
    for (const [p, l] of perPath.entries()) {
      if (l.length >= 3) {
        rereadPaths++
        rereadExtraCalls += l.length - 1
        rereadExtraChars += l.slice(1).reduce((s, c) => s + c.chars, 0)
        const base = basename(p)
        const rb = rereadBasenames.get(base) ?? { n: 0, chars: 0, shapes: new Map() }
        rb.n += l.length
        rb.chars += l.reduce((s, c) => s + c.chars, 0)
        for (const c of l) bump(rb.shapes, readShape(c.input))
        rereadBasenames.set(base, rb)
      }
      // Slice-walk: count range reads before any outline/symbol read of the path.
      let ranges = 0
      let rangeChars = 0
      let chain = 0
      let chainChars = 0
      let bestChain = 0
      let bestChainChars = 0
      let prevEnd: number | null = null
      for (const c of l) {
        const s = readShape(c.input)
        if (s === 'outline' || s === 'symbol') break
        if (s === 'range') {
          ranges++
          rangeChars += c.chars
          const off = Number(c.input.offset ?? 1)
          const lim = Number(c.input.limit ?? 2000)
          if (prevEnd !== null && Math.abs(off - prevEnd) <= 20) {
            chain++
            chainChars += c.chars
          } else {
            chain = 1
            chainChars = c.chars
          }
          if (chain > bestChain) {
            bestChain = chain
            bestChainChars = chainChars
          }
          prevEnd = off + lim
        }
      }
      if (ranges >= 3) {
        sliceWalks++
        sliceWalkCalls += ranges
        sliceWalkChars += rangeChars
      }
      if (bestChain >= 3) {
        contiguousWalks++
        contiguousWalkCalls += bestChain
        contiguousWalkChars += bestChainChars
      }
      const edits = editedAt.get(`${l[0]!.file}\u0000${p}`)
      if (edits) {
        for (const c of l) {
          if (edits.some(e => e < c.seq && !l.some(o => o.seq > e && o.seq < c.seq))) {
            readAfterEdit++
            readAfterEditChars += c.chars
          }
        }
      }
      for (let i = 0; i < l.length; i++) {
        const a = l[i]!
        if (!READ_OUTLINE_RE.test(a.text)) continue
        const auto = a.text.includes(READ_AUTO_PIVOT)
        const next = l[i + 1]
        const target = auto ? followAfterAuto : followAfterExplicit
        if (!next) {
          bump(target, 'none')
          continue
        }
        const shape = readShape(next.input)
        bump(target, shape)
        if (shape === 'full(explicit)' || shape === 'full(default)') {
          outlineThenFullSameFile++
          outlineThenFullChars += next.chars
        }
      }
    }
  }

  return {
    calls: reads.length,
    byShape: [...byShape.entries()].map(([shape, s]) => ({
      shape,
      n: s.n,
      chars: s.chars,
      median: median(s.sizes),
      errors: s.errors,
    })),
    byShapeMain: sortedEntries(byShapeMain),
    byShapeSub: sortedEntries(byShapeSub),
    outlineResults,
    overcap,
    autoPivots,
    autoPivotChars,
    autoPivotSourceLines,
    defaultOver10k,
    defaultOver10kChars,
    defaultOver10kExt: sortedEntries(defaultOver10kExt),
    followAfterAuto: sortedEntries(followAfterAuto),
    followAfterExplicit: sortedEntries(followAfterExplicit),
    outlineThenFullSameFile,
    outlineThenFullChars,
    distinctPaths,
    rereadPaths,
    rereadExtraCalls,
    rereadExtraChars,
    rereadBasenames: [...rereadBasenames.entries()]
      .sort((a, b) => b[1].chars - a[1].chars)
      .slice(0, 10)
      .map(([base, r]) => ({ base, n: r.n, chars: r.chars, shapes: sortedEntries(r.shapes) })),
    sliceWalks,
    sliceWalkCalls,
    sliceWalkChars,
    contiguousWalks,
    contiguousWalkCalls,
    contiguousWalkChars,
    readAfterEdit,
    readAfterEditChars,
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function overview(calls: Call[]) {
  const byTool = new Map<string, { n: number; chars: number; errors: number; sub: number }>()
  for (const c of calls) {
    const t = byTool.get(c.tool) ?? { n: 0, chars: 0, errors: 0, sub: 0 }
    t.n++
    t.chars += c.chars
    if (c.isError) t.errors++
    if (c.sub) t.sub++
    byTool.set(c.tool, t)
  }
  const totalChars = calls.reduce((s, c) => s + c.chars, 0)
  return {
    calls: calls.length,
    totalChars,
    sessions: new Set(calls.map(c => c.session)).size,
    transcripts: new Set(calls.map(c => c.file)).size,
    subCalls: calls.filter(c => c.sub).length,
    byTool: [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars),
    symbolTools: {
      Rename: byTool.get('Rename')?.n ?? 0,
      LSP: byTool.get('LSP')?.n ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

function printBash(b: BashReport): void {
  console.log('\n== Bash output filter ==')
  console.log(
    `calls=${b.calls} blocked=${b.blocked} errors=${b.errors} ran=${b.ran} unanswered=${b.unanswered}`,
  )
  if (b.blockedBy.length) {
    console.log(`  blocked → ${b.blockedBy.map(([t, n]) => `${t}:${n}`).join('  ')}`)
  }
  for (const [lead, n] of b.unparsedLeads.slice(0, 6)) console.log(`    unparsed ×${n}: ${lead}`)
  console.log(
    `  ran: filtered=${b.filtered} (${pct(b.filtered, b.ran)}) rewritten-only=${b.rewrittenOnly} persisted=${b.persisted} raw=${b.raw} (${pct(b.raw, b.ran)})`,
  )
  console.log(
    `  filtered chars: sent=${kb(b.filteredWrapped)} body=${kb(b.filteredBody)} est.original=${kb(b.filteredEstOriginal)} saved≈${kb(b.filteredEstOriginal - b.filteredWrapped)} wrapper-overhead=${kb(b.filteredWrapped - b.filteredBody)}`,
  )
  console.log(
    `  raw chars: ${kb(b.rawChars)} over ${b.raw} results; ≥1K: ${b.rawBig} results / ${kb(b.rawBigChars)} (${b.rawBigCompound} compound)`,
  )
  console.log(`  reduction median=${b.reductionMedian}%  ${b.reductionBuckets.map(([k, n]) => `${k}:${n}`).join('  ')}`)
  console.log('  filtered by head (saved desc):')
  for (const [head, h] of b.filteredHeads.slice(0, 12)) {
    console.log(`    ${pad(head, 26)} n=${padLeft(String(h.n), 3)} body=${padLeft(kb(h.body), 7)} saved≈${padLeft(kb(h.saved), 7)}`)
  }
  console.log('  raw by head (chars desc):')
  for (const [head, h] of b.rawHeads.slice(0, 14)) {
    console.log(
      `    ${pad(head, 26)} n=${padLeft(String(h.n), 3)} chars=${padLeft(kb(h.chars), 7)} ≥1K=${padLeft(String(h.big), 3)} compound=${h.compound}`,
    )
  }
  if (b.rewrites.length) {
    console.log('  rewrites:')
    for (const [r, n] of b.rewrites.slice(0, 10)) console.log(`    ${padLeft(String(n), 3)}  ${r.slice(0, 110)}`)
  }
  const a = b.anomalies
  console.log(
    `  anomalies: body>original lines=${a.moreLinesThanOriginal.length}  listing-with-omitted-lines=${a.listingOmitted.length}  reduction<15%=${a.marginal.length}`,
  )
  for (const x of a.moreLinesThanOriginal.slice(0, 6)) console.log(`    lines↑  ${pad(x.head, 20)} lines=${x.lines}`)
  for (const x of a.listingOmitted.slice(0, 8)) console.log(`    omitted ${pad(x.head, 20)} lines=${x.lines} omitted=${x.omitted}`)
  console.log('  head/tail cap by head:')
  for (const [head, h] of b.cappedHeads.slice(0, 10)) {
    console.log(`    ${pad(head, 26)} n=${padLeft(String(h.n), 3)} original lines=${padLeft(fmt(h.orig), 6)} omitted=${padLeft(fmt(h.omitted), 6)}`)
  }
  console.log(`  after a capped result (next 3 calls): ${b.afterCap.map(([k, n]) => `${k}:${n}`).join('  ') || '(none)'}`)
  console.log(`    re-asked about the same target, by head: ${b.reaskHeads.map(([k, n]) => `${k}:${n}`).join('  ') || '(none)'}`)
  console.log('  largest raw results:')
  for (const x of b.bigRaw) console.log(`    ${padLeft(kb(x.chars), 7)}  ${pad(x.head, 24)} ${x.compound ? 'compound' : 'atomic'}`)
}

function printGrep(g: ReturnType<typeof grepReport>): void {
  console.log('\n== Grep output modes ==')
  console.log(`calls=${g.calls}`)
  for (const m of g.byMode) {
    console.log(
      `  ${pad(m.mode, 20)} n=${padLeft(String(m.n), 4)} (${padLeft(pct(m.n, g.calls), 6)}) chars=${padLeft(kb(m.chars), 8)} median=${padLeft(kb(m.median), 6)} no-match=${m.noMatch} errors=${m.errors}`,
    )
  }
  console.log(`  main: ${g.byModeMain.map(([m, n]) => `${m}:${n}`).join('  ')}`)
  console.log(`  sub-agents: ${g.byModeSub.map(([m, n]) => `${m}:${n}`).join('  ')}`)
  console.log(
    `  inputs: head_limit=${g.withHeadLimit} (of which 0=unlimited: ${g.withHeadLimitZero} / ${kb(g.withHeadLimitZeroChars)}) context(-A/-B/-C)=${g.withContext} path=${g.withPath} glob/type=${g.withGlobOrType} multiline=${g.withMultiline}`,
  )
  console.log(
    `    head_limit=0 by mode: ${g.headLimitZeroByMode.map(([m, n]) => `${m}:${n}`).join('  ')};  content & >6K: ${g.headLimitZeroContentBig} / ${kb(g.headLimitZeroContentBigChars)}`,
  )
  console.log(
    `  results: auto-pivot→symbols=${g.autoPivot} explicit symbols=${g.explicitSymbols} incomplete=${g.incomplete} ignored-fallback=${g.ignoredFallback} paginated=${g.paginated}`,
  )
  console.log(
    `  content >6K (regrouped): ${g.contentOver6k} / ${kb(g.contentOver6kChars)} (with head_limit: ${g.contentOver6kWithLimit}, with -A/-B/-C: ${g.contentOver6kWithContext});  content with no path AND no head_limit: ${g.contentNoScopeNoLimit} / ${kb(g.contentNoScopeNoLimitChars)}`,
  )
  console.log(`  same-pattern re-runs: ${g.transitions.map(([t, n]) => `${t}:${n}`).join('  ') || '(none)'}`)
  console.log(`    head_limit on the >6K content results: ${g.contentOver6kLimits.map(([k, n]) => `${k}:${n}`).join('  ')}`)
  console.log(`    content → content by what changed: ${g.contentRerunKinds.map(([k, n]) => `${k}:${n}`).join('  ') || '(none)'}`)
  console.log(`  after auto-pivot: took hint (head_limit/narrower)=${g.pivotThenHint} re-ran same=${g.pivotThenSame} no re-run=${g.pivotThenNothing}`)
}

function printRead(r: ReturnType<typeof readReport>): void {
  console.log('\n== Read shape ==')
  console.log(`calls=${r.calls} distinct paths (per transcript)=${r.distinctPaths}`)
  for (const s of r.byShape.sort((a, b) => b.n - a.n)) {
    console.log(
      `  ${pad(s.shape, 16)} n=${padLeft(String(s.n), 4)} (${padLeft(pct(s.n, r.calls), 6)}) chars=${padLeft(kb(s.chars), 8)} median=${padLeft(kb(s.median), 6)} errors=${s.errors}`,
    )
  }
  console.log(`  main: ${r.byShapeMain.map(([m, n]) => `${m}:${n}`).join('  ')}`)
  console.log(`  sub-agents: ${r.byShapeSub.map(([m, n]) => `${m}:${n}`).join('  ')}`)
  console.log(
    `  outline results=${r.outlineResults} of which auto-pivot=${r.autoPivots} (${kb(r.autoPivotChars)} sent for ${fmt(r.autoPivotSourceLines)} source lines) overcap=${r.overcap}`,
  )
  console.log(`  follow-up after AUTO outline (same path): ${r.followAfterAuto.map(([m, n]) => `${m}:${n}`).join('  ') || '(none)'}`)
  console.log(`  follow-up after EXPLICIT outline (same path): ${r.followAfterExplicit.map(([m, n]) => `${m}:${n}`).join('  ') || '(none)'}`)
  console.log(`  outline → full body of the same file: ${r.outlineThenFullSameFile} (${kb(r.outlineThenFullChars)} — the outline bought nothing there)`)
  console.log(
    `  full(default) bodies >10K that did NOT pivot: ${r.defaultOver10k} / ${kb(r.defaultOver10kChars)}  by ext: ${r.defaultOver10kExt.map(([e, n]) => `${e}:${n}`).join(' ')}`,
  )
  console.log(`  paths read ≥3× in one transcript: ${r.rereadPaths} paths, ${r.rereadExtraCalls} extra calls, ${kb(r.rereadExtraChars)}`)
  console.log(`  slice-walks (3+ range reads of a path with no outline/symbol first): ${r.sliceWalks} paths, ${r.sliceWalkCalls} calls, ${kb(r.sliceWalkChars)}`)
  console.log(`    of which contiguous (each offset resumes where the last slice ended): ${r.contiguousWalks} paths, ${r.contiguousWalkCalls} calls, ${kb(r.contiguousWalkChars)}`)
  console.log(`  read of a path right after editing it: ${r.readAfterEdit} calls, ${kb(r.readAfterEditChars)}`)
  console.log('  most re-read basenames (per transcript, chars desc):')
  for (const x of r.rereadBasenames) {
    console.log(`    ${pad(x.base, 34)} n=${padLeft(String(x.n), 3)} chars=${padLeft(kb(x.chars), 7)}  ${x.shapes.map(([s, n]) => `${s}:${n}`).join(' ')}`)
  }
}

function printOverview(o: ReturnType<typeof overview>): void {
  console.log('== Overview ==')
  console.log(
    `sessions=${o.sessions} transcripts=${o.transcripts} tool calls=${o.calls} (sub-agent ${o.subCalls}) result chars=${kb(o.totalChars)}`,
  )
  for (const [tool, t] of o.byTool.slice(0, 16)) {
    console.log(
      `  ${pad(tool, 18)} n=${padLeft(String(t.n), 5)} chars=${padLeft(kb(t.chars), 9)} (${padLeft(pct(t.chars, o.totalChars), 6)}) errors=${padLeft(String(t.errors), 3)} sub=${t.sub}`,
    )
  }
}

function printSymbols(o: ReturnType<typeof overview>, g: ReturnType<typeof grepReport>, r: ReturnType<typeof readReport>): void {
  console.log('\n== Symbols surface ==')
  const readSymbol = r.byShape.find(s => s.shape === 'symbol')?.n ?? 0
  const readOutline = r.byShape.find(s => s.shape === 'outline')?.n ?? 0
  console.log(
    `  Read outline (explicit)=${readOutline}  Read auto-outline=${r.autoPivots}  Read symbol=${readSymbol}  Grep symbols (explicit)=${g.explicitSymbols}  Grep auto-pivot=${g.autoPivot}  Rename=${o.symbolTools.Rename}  LSP=${o.symbolTools.LSP}`,
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  let dirs = projectDirs(args.project)
  if (!args.project) {
    const own = dirs.filter(d => basename(d) === cwdSlug())
    if (own.length > 0) dirs = own
  }
  const sinceMs = Date.parse(`${args.since}T00:00:00`)
  const files = transcriptFiles(dirs)
    .filter(t => t.mtimeMs >= sinceMs)
    .map(t => t.path)
  const all = walk(files)
  const calls = all.filter(c => {
    if (Number.isNaN(c.ts)) return false
    const d = localDate(c.ts)
    if (d < args.since || d > args.until) return false
    return !args.exclude.has(c.session)
  })
  if (calls.length === 0) {
    console.error(`no tool calls between ${args.since} and ${args.until} under ${dirs.join(', ')}`)
    process.exit(1)
  }
  const o = overview(calls)
  const b = bashReport(calls)
  const g = grepReport(calls)
  const r = readReport(calls)
  if (args.json) {
    console.log(JSON.stringify({ overview: o, bash: b, grep: g, read: r }, null, 2))
    return
  }
  console.log(`window=${args.since}..${args.until} files scanned=${files.length} excluded sessions=${[...args.exclude].join(',') || '(none)'}`)
  printOverview(o)
  printBash(b)
  printGrep(g)
  printRead(r)
  printSymbols(o, g, r)
}

main()
