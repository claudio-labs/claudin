/**
 * Measure how much of an Explore sub-agent's report the parent throws away.
 *
 * The Explore agent earns its keep by keeping raw tool output out of the
 * parent's context (measured at 13.2x median compression). It loses that
 * again every time the parent, having read the report, re-opens a file the
 * report already covered. This script measures both sides of that trade over
 * the recorded session transcripts, so a prompt change can be checked against
 * a real baseline instead of a hunch.
 *
 * The four numbers it reports, and the 2026-08-16 baseline for each:
 *
 *   1. Explore calls followed by >=1 FULL re-read of a reported file  29.4% (25/85)
 *   2. Distinct reported files later re-read in full                   3.6% (45/1262)
 *   3. Median compression (raw chars consumed / report chars out)     13.2x (n=91)
 *   4. Explore's OWN Reads that are targeted (outline|symbol)         22.7% (1365/6024)
 *
 * Metrics 1-2 are main-chain: they read `<projectDir>/<sessionId>.jsonl` and
 * pair each `Agent(subagent_type:"Explore")` call with the result that landed
 * for it. Metrics 3-4 read the sub-agent transcripts under
 * `<projectDir>/<sessionId>/subagents/`.
 *
 * TWO DIFFERENT DENOMINATORS, on purpose — they are not interchangeable, and
 * the output labels which one each rate uses:
 *   - metric 3 covers Explore runs LINKED to a main-chain call (n=91), because
 *     that is the population whose reports the parent actually consumed;
 *   - metric 4 covers EVERY Explore transcript on disk (n=383), which is a
 *     superset: nested agents spawn their own Explore runs that never appear
 *     as a main-chain call. Over the linked set the same rate is 14.2%, so
 *     quoting one number against the other invents a 8.5pp change.
 *
 * Running it after a change:
 *
 *   bun scripts/bench/tokens/measure-explore-redundancy.ts --since 2026-08-17
 *
 * The post-change sample is small at first, so every rate is printed with its
 * N. A percentage over a handful of calls is not a result.
 *
 * Flags:
 *   --since=YYYY-MM-DD  only sessions whose first message is on/after this date
 *   --examples          also print the calls with the most full re-reads
 *   --json              machine-readable output
 *   [projectDir]        positional: a transcript project dir. Defaults to this
 *                       repo's, derived from REPO_ROOT the way the CLI does.
 *
 * Read-only. No network. No filesystem writes.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT } from '../../repoRoot.js'
import {
  readConfigDirEnv,
  resolveClaudinConfigHomeDir,
} from '../../../src/shared/envUtils.js'
import { sanitizePath } from '../../../src/sessions/sessionStoragePortable.js'

/** Matches a file-ish path inside report prose. */
const PATH_RE =
  /(?:^|[\s`'"(\[|>*,])((?:\/|\.{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.(?:tsx?|jsx?|mjs|cjs|md|json|ya?ml|sh|py|rs|go|css|html|d\.ts))/g
const LEADING_PUNCT_RE = /^["'`(\[]+/
const TRAILING_PUNCT_RE = /[)\]"'`,.:;]+$/
const ABS_REPO_PREFIX_RE = /^\/home\/[\w.-]+\/projects\/[\w.-]+\//
const DOT_SLASH_RE = /^\.\//
const LEADING_SLASH_RE = /^\/+/
const JSONL_SUFFIX_RE = /\.jsonl$/
const META_SUFFIX_RE = /\.meta\.json$/
const AGENT_PREFIX_RE = /^agent-/
const ASYNC_LAUNCH_RE = /Async agent launched/
const AGENT_ID_RE = /agentId:\s*(\w+)/
const TASK_NOTIFICATION_RE = /<task-notification>/
const NOTIF_TOOL_ID_RE = /<tool-use-id>(toolu_\w+)<\/tool-use-id>/
const NOTIF_RESULT_RE = /<result>([\s\S]*?)<\/result>/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const READ_TOOL_NAMES = new Set(['Read', 'FileRead'])
const EXPLORE_AGENT_TYPE = 'Explore'

export type ExploreCallRow = {
  session: string
  description: string
  promptHead: string
  reportChars: number
  /** Distinct file paths the report named. */
  reportedFiles: string[]
  /** Parent Reads issued after the report landed, in tool-call order. */
  reads: ReadRow[]
}

export type ReadRow = {
  path: string
  /** symbol / offset / limit / view:'outline' — i.e. NOT a whole-file read. */
  targeted: boolean
  /** Position among the parent's tool calls after the report landed. */
  ordinal: number
  /** The report already named this path. */
  hit: boolean
}

export type SubagentRun = {
  /** Raw tool_result chars the sub-agent consumed internally. */
  resultChars: number
  /** Chars of the final assistant message it returned. */
  reportChars: number
  reads: number
  /** Reads using view:'outline' or symbol: — the baseline's definition. */
  targetedNarrow: number
  /** …plus offset/limit. Reported separately; it is a very different number. */
  targetedWide: number
  /** Paired with a main-chain Agent(Explore) call in the same session. */
  linked: boolean
}

export type RedundancyResult = {
  projectDir: string
  since: string | null
  sessions: number
  agentCalls: number
  exploreCalls: number
  callsWithReport: number
  malformedLines: number
  /** Skipped by --since because no timestamp could be found for them. */
  undatedSessions: number
  calls: ExploreCallRow[]
  subagentRuns: SubagentRun[]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a'
  return `${((numerator * 100) / denominator).toFixed(1)}%`
}

/** Strip quoting/punctuation and make the path repo-relative for comparison. */
function normalizePath(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    .replace(LEADING_PUNCT_RE, '')
    .replace(TRAILING_PUNCT_RE, '')
    .replace(ABS_REPO_PREFIX_RE, '')
    .replace(DOT_SLASH_RE, '')
    .replace(LEADING_SLASH_RE, '')
  return cleaned.length > 0 ? cleaned : null
}

function pathsIn(text: string): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  PATH_RE.lastIndex = 0
  let match = PATH_RE.exec(text)
  while (match !== null) {
    const normalized = normalizePath(match[1])
    if (normalized !== null && normalized.includes('/')) out.add(normalized)
    match = PATH_RE.exec(text)
  }
  return out
}

type ContentBlock = {
  type?: string
  text?: string
  name?: string
  id?: string
  tool_use_id?: string
  input?: Record<string, unknown>
  content?: unknown
}

type TranscriptLine = {
  type?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  message?: { id?: string; content?: unknown }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block =>
        typeof block === 'string' ? block : ((block as ContentBlock).text ?? ''),
      )
      .join('\n')
  }
  return ''
}

function blocksOf(message: TranscriptLine['message']): ContentBlock[] {
  const content = message?.content
  return Array.isArray(content) ? (content as ContentBlock[]) : []
}

/** Counts lines that were not valid JSON, rather than swallowing them. */
type ParseTally = { malformed: number }

function parseLines(raw: string, tally: ParseTally): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as TranscriptLine)
    } catch {
      // A truncated final line is normal for a live session; a burst of them
      // is not. Counted and reported instead of ignored.
      tally.malformed++
    }
  }
  return out
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
    throw error
  }
}

function listDirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

/** A tool result too large to inline is spilled to `tool-results/<id>.txt`. */
function loadSpilledResult(sessionDir: string, toolUseId: string): string | null {
  return readFileOrNull(join(sessionDir, 'tool-results', `${toolUseId}.txt`))
}

type MainChainEvent =
  | { kind: 'tool_use'; name: string; id: string; input: Record<string, unknown> }
  | { kind: 'result'; id: string; text: string }
  | { kind: 'notif'; id: string | null; text: string }

function toEvents(lines: readonly TranscriptLine[]): MainChainEvent[] {
  const events: MainChainEvent[] = []
  for (const line of lines) {
    if (line.isSidechain === true) continue
    if (line.type === 'assistant') {
      for (const block of blocksOf(line.message)) {
        if (block.type === 'tool_use' && block.name && block.id) {
          events.push({
            kind: 'tool_use',
            name: block.name,
            id: block.id,
            input: block.input ?? {},
          })
        }
      }
      continue
    }
    if (line.type !== 'user') continue
    const content = line.message?.content
    if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            kind: 'result',
            id: block.tool_use_id,
            text: textOf(block.content),
          })
        }
      }
    } else if (
      typeof content === 'string' &&
      TASK_NOTIFICATION_RE.test(content)
    ) {
      // A backgrounded agent's report arrives as a notification, not a result.
      const idMatch = content.match(NOTIF_TOOL_ID_RE)
      const resultMatch = content.match(NOTIF_RESULT_RE)
      events.push({
        kind: 'notif',
        id: idMatch?.[1] ?? null,
        text: resultMatch?.[1] ?? '',
      })
    }
  }
  return events
}

function isTargetedRead(input: Record<string, unknown>): boolean {
  return (
    input['symbol'] !== undefined ||
    input['offset'] !== undefined ||
    input['limit'] !== undefined ||
    input['view'] === 'outline'
  )
}

/** First message timestamp, for --since. Null when the session has none. */
function sessionDate(lines: readonly TranscriptLine[]): string | null {
  for (const line of lines) {
    if (typeof line.timestamp === 'string' && line.timestamp.length >= 10) {
      return line.timestamp.slice(0, 10)
    }
  }
  return null
}

/**
 * Fallback date for a session whose main transcript is absent or undated —
 * common for a session that only holds sub-agent transcripts.
 */
function subagentDate(
  subagents: readonly SubagentIndexEntry[],
  tally: ParseTally,
): string | null {
  for (const entry of subagents) {
    const raw = readFileOrNull(join(entry.dir, `agent-${entry.agentId}.jsonl`))
    if (raw === null) continue
    const date = sessionDate(parseLines(raw, tally))
    if (date !== null) return date
  }
  return null
}

function analyzeSubagentTranscript(
  path: string,
  tally: ParseTally,
): Omit<SubagentRun, 'linked'> | null {
  const raw = readFileOrNull(path)
  if (raw === null) return null
  let resultChars = 0
  let reportChars = 0
  let reads = 0
  let targetedNarrow = 0
  let targetedWide = 0
  for (const line of parseLines(raw, tally)) {
    if (line.type === 'assistant') {
      const blocks = blocksOf(line.message)
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
      // The LAST non-empty assistant text is the report it returned.
      if (text.trim().length > 0) reportChars = text.length
      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.name) continue
        if (!READ_TOOL_NAMES.has(block.name)) continue
        const input = block.input ?? {}
        reads++
        if (input['view'] === 'outline' || input['symbol'] !== undefined) {
          targetedNarrow++
        }
        if (isTargetedRead(input)) targetedWide++
      }
      continue
    }
    if (line.type !== 'user') continue
    for (const block of blocksOf(line.message)) {
      if (block.type === 'tool_result') resultChars += textOf(block.content).length
    }
  }
  return { resultChars, reportChars, reads, targetedNarrow, targetedWide }
}

type SubagentIndexEntry = {
  agentId: string
  agentType: string
  description: string
  dir: string
}

function indexSubagents(sessionDir: string): SubagentIndexEntry[] {
  const dir = join(sessionDir, 'subagents')
  const out: SubagentIndexEntry[] = []
  for (const file of listDirOrEmpty(dir)) {
    if (!file.endsWith('.meta.json')) continue
    const raw = readFileOrNull(join(dir, file))
    if (raw === null) continue
    let meta: { agentType?: string; description?: string }
    try {
      meta = JSON.parse(raw) as { agentType?: string; description?: string }
    } catch (error) {
      console.warn(`skipping unreadable meta ${join(dir, file)}: ${String(error)}`)
      continue
    }
    out.push({
      agentId: file.replace(AGENT_PREFIX_RE, '').replace(META_SUFFIX_RE, ''),
      agentType: meta.agentType ?? '',
      description: meta.description ?? '',
      dir,
    })
  }
  return out
}

export function measureExploreRedundancy(options: {
  projectDir: string
  since: string | null
}): RedundancyResult {
  const { projectDir, since } = options
  const tally: ParseTally = { malformed: 0 }
  const result: RedundancyResult = {
    projectDir,
    since,
    sessions: 0,
    agentCalls: 0,
    exploreCalls: 0,
    callsWithReport: 0,
    malformedLines: 0,
    undatedSessions: 0,
    calls: [],
    subagentRuns: [],
  }

  // A session contributes a main transcript, a subagents/ dir, or both. The
  // metric-4 denominator is EVERY Explore transcript on disk, including ones
  // spawned by another agent — those sessions have no main-chain Agent call,
  // so keying the walk off *.jsonl alone would drop most of them.
  const dirEntries = listDirOrEmpty(projectDir)
  const sessionIds = new Set<string>()
  for (const entry of dirEntries) {
    if (entry.endsWith('.jsonl')) {
      sessionIds.add(entry.replace(JSONL_SUFFIX_RE, ''))
      continue
    }
    const stats = statSync(join(projectDir, entry), { throwIfNoEntry: false })
    if (stats?.isDirectory() === true) sessionIds.add(entry)
  }
  if (sessionIds.size === 0) {
    throw new Error(
      `no session transcripts under ${projectDir} — pass the project dir as a positional argument`,
    )
  }

  for (const sessionId of sessionIds) {
    const sessionDir = join(projectDir, sessionId)
    const raw = readFileOrNull(join(projectDir, `${sessionId}.jsonl`))
    const lines = raw === null ? [] : parseLines(raw, tally)
    const subagents = indexSubagents(sessionDir)

    if (since !== null) {
      const date = sessionDate(lines) ?? subagentDate(subagents, tally)
      if (date === null) {
        result.undatedSessions++
        continue
      }
      if (date < since) continue
    }

    const usedSubagents = new Set<string>()
    const hasMainChainAgent = raw !== null && raw.includes('"Agent"')
    const events = hasMainChainAgent ? toEvents(lines) : []
    if (hasMainChainAgent) result.sessions++

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!
      if (event.kind !== 'tool_use' || event.name !== 'Agent') continue
      result.agentCalls++
      if (event.input['subagent_type'] !== EXPLORE_AGENT_TYPE) continue
      result.exploreCalls++

      // Walk forward for the result (or the notification, when backgrounded).
      let reportText = ''
      let landedAt = i
      for (let j = i + 1; j < events.length; j++) {
        const candidate = events[j]!
        if (candidate.kind === 'tool_use') continue
        if (candidate.id !== event.id) continue
        if (candidate.kind === 'result') {
          let text = candidate.text
          if (ASYNC_LAUNCH_RE.test(text)) continue // the real report follows
          if (text.length < 200) {
            const spilled = loadSpilledResult(sessionDir, event.id)
            if (spilled !== null) text = spilled
          }
          reportText = text
          landedAt = j
          break
        }
        reportText = candidate.text
        landedAt = j
        break
      }
      if (reportText === '') {
        const spilled = loadSpilledResult(sessionDir, event.id)
        if (spilled !== null) reportText = spilled
      }

      const reported = pathsIn(reportText)
      const reads: ReadRow[] = []
      let ordinal = 0
      for (let j = landedAt + 1; j < events.length; j++) {
        const later = events[j]!
        if (later.kind !== 'tool_use') continue
        ordinal++
        if (!READ_TOOL_NAMES.has(later.name)) continue
        const path = normalizePath(
          typeof later.input['file_path'] === 'string'
            ? later.input['file_path']
            : undefined,
        )
        if (path === null) continue
        reads.push({
          path,
          targeted: isTargetedRead(later.input),
          ordinal,
          hit: reported.has(path),
        })
      }

      if (reported.size > 0) result.callsWithReport++
      const prompt =
        typeof event.input['prompt'] === 'string' ? event.input['prompt'] : ''
      const description =
        typeof event.input['description'] === 'string'
          ? event.input['description']
          : ''
      result.calls.push({
        session: sessionId,
        description,
        promptHead: (prompt.split('\n')[0] ?? '').slice(0, 110),
        reportChars: reportText.length,
        reportedFiles: [...reported],
        reads,
      })

      // Pair with the sub-agent transcript by description, so metric 3 is
      // scoped to runs the parent actually consumed.
      const match =
        subagents.find(
          s =>
            s.agentType === EXPLORE_AGENT_TYPE &&
            s.description === description &&
            !usedSubagents.has(s.agentId),
        ) ??
        subagents.find(
          s =>
            s.agentType === EXPLORE_AGENT_TYPE && s.description === description,
        )
      if (match) usedSubagents.add(match.agentId)
    }

    // Every Explore transcript in this session — the metric-4 denominator.
    for (const entry of subagents) {
      if (entry.agentType !== EXPLORE_AGENT_TYPE) continue
      const run = analyzeSubagentTranscript(
        join(entry.dir, `agent-${entry.agentId}.jsonl`),
        tally,
      )
      if (run === null) continue
      result.subagentRuns.push({ ...run, linked: usedSubagents.has(entry.agentId) })
    }
  }

  result.malformedLines = tally.malformed
  return result
}

type Metrics = {
  fullReReadCalls: number
  callsWithReport: number
  distinctReported: number
  distinctFullReRead: number
  compressionRatios: number[]
  linkedRuns: number
  narrowTargeted: number
  narrowTotal: number
  wideTargeted: number
  linkedTargeted: number
  linkedReads: number
}

function computeMetrics(result: RedundancyResult): Metrics {
  const withReport = result.calls.filter(c => c.reportedFiles.length > 0)
  let distinctReported = 0
  let distinctFullReRead = 0
  let fullReReadCalls = 0
  for (const call of withReport) {
    distinctReported += call.reportedFiles.length
    const fullHits = new Set(
      call.reads.filter(r => r.hit && !r.targeted).map(r => r.path),
    )
    distinctFullReRead += fullHits.size
    if (fullHits.size > 0) fullReReadCalls++
  }

  const linked = result.subagentRuns.filter(r => r.linked)
  const compressionRatios = linked
    .filter(r => r.resultChars > 0 && r.reportChars > 0)
    .map(r => r.resultChars / r.reportChars)

  return {
    fullReReadCalls,
    callsWithReport: withReport.length,
    distinctReported,
    distinctFullReRead,
    compressionRatios,
    linkedRuns: linked.length,
    narrowTargeted: result.subagentRuns.reduce(
      (a, r) => a + r.targetedNarrow,
      0,
    ),
    narrowTotal: result.subagentRuns.reduce((a, r) => a + r.reads, 0),
    wideTargeted: result.subagentRuns.reduce((a, r) => a + r.targetedWide, 0),
    linkedTargeted: linked.reduce((a, r) => a + r.targetedNarrow, 0),
    linkedReads: linked.reduce((a, r) => a + r.reads, 0),
  }
}

function formatReport(
  result: RedundancyResult,
  metrics: Metrics,
  examples: boolean,
): string {
  const lines: string[] = []
  lines.push('# Explore report redundancy')
  lines.push(`project dir : ${result.projectDir}`)
  lines.push(`since       : ${result.since ?? '(all sessions)'}`)
  lines.push(
    `corpus      : ${result.sessions} sessions with Agent calls, ${result.agentCalls} Agent calls, ${result.exploreCalls} Explore calls`,
  )
  lines.push(
    `sub-agents  : ${result.subagentRuns.length} Explore transcripts on disk (${metrics.linkedRuns} linked to a main-chain call)`,
  )
  if (result.malformedLines > 0) {
    lines.push(`note        : ${result.malformedLines} unparseable transcript line(s) skipped`)
  }
  if (result.undatedSessions > 0) {
    lines.push(
      `note        : ${result.undatedSessions} session(s) dropped by --since — no timestamp found`,
    )
  }
  lines.push('')

  lines.push('1. Explore calls followed by >=1 FULL re-read of a reported file')
  lines.push(
    `   ${metrics.fullReReadCalls} / ${metrics.callsWithReport} calls with a parsable report = ${pct(metrics.fullReReadCalls, metrics.callsWithReport)}`,
  )
  lines.push('   baseline 2026-08-16: 29.4% (25/85)   ← lower is better')
  lines.push('')

  lines.push('2. Distinct reported files the parent later re-read IN FULL')
  lines.push(
    `   ${metrics.distinctFullReRead} / ${metrics.distinctReported} distinct reported files = ${pct(metrics.distinctFullReRead, metrics.distinctReported)}`,
  )
  lines.push('   baseline 2026-08-16: 3.6% (45/1262)  ← lower is better')
  lines.push('')

  lines.push('3. Median compression inside the sub-agent (raw consumed / report out)')
  lines.push(
    `   ${median(metrics.compressionRatios).toFixed(1)}x over ${metrics.compressionRatios.length} LINKED Explore runs`,
  )
  lines.push('   baseline 2026-08-16: 13.2x (n=91)    ← higher is better; a')
  lines.push('   drop here means the excerpt rule made reports too fat.')
  lines.push('')

  lines.push("4. Explore's OWN Reads that are targeted (view:'outline' or symbol:)")
  lines.push(
    `   ${metrics.narrowTargeted} / ${metrics.narrowTotal} reads = ${pct(metrics.narrowTargeted, metrics.narrowTotal)}  [ALL ${result.subagentRuns.length} transcripts on disk]`,
  )
  lines.push('   baseline 2026-08-16: 22.7% (1365/6024)  ← higher is better')
  lines.push(
    `   same rate over LINKED runs only: ${pct(metrics.linkedTargeted, metrics.linkedReads)} (${metrics.linkedTargeted}/${metrics.linkedReads}) [baseline 14.2%]`,
  )
  lines.push(
    `   widened to include offset/limit: ${pct(metrics.wideTargeted, metrics.narrowTotal)} (${metrics.wideTargeted}/${metrics.narrowTotal}) [baseline 62.9%]`,
  )
  lines.push('   — a different definition, not a different result. Do not mix.')

  if (examples) {
    lines.push('')
    lines.push('## Calls with the most full re-reads')
    const worst = result.calls
      .map(call => ({
        call,
        n: new Set(
          call.reads.filter(r => r.hit && !r.targeted).map(r => r.path),
        ).size,
      }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
    if (worst.length === 0) lines.push('  (none)')
    for (const { call, n } of worst) {
      lines.push(
        `- ${call.session.slice(0, 8)} [${call.description}] ${n} full re-read(s) of ${call.reportedFiles.length} reported files`,
      )
      lines.push(`    "${call.promptHead}"`)
      for (const read of call.reads
        .filter(r => r.hit && !r.targeted)
        .slice(0, 6)) {
        lines.push(`    +${read.ordinal} FULL  ${read.path}`)
      }
    }
  }

  return lines.join('\n')
}

function defaultProjectDir(): string {
  const configHome = resolveClaudinConfigHomeDir({
    configDirEnv: readConfigDirEnv(),
  })
  return join(configHome, 'projects', sanitizePath(REPO_ROOT))
}

function parseArgs(argv: readonly string[]): {
  projectDir: string
  since: string | null
  examples: boolean
  asJson: boolean
} {
  let projectDir: string | null = null
  let since: string | null = null
  let examples = false
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg === '--examples') examples = true
    else if (arg.startsWith('--since=') || arg.startsWith('--since ')) {
      since = arg.slice('--since='.length)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`)
    } else if (projectDir === null) {
      projectDir = arg
    } else {
      throw new Error(`unexpected extra argument: ${arg}`)
    }
  }
  if (since !== null && !DATE_RE.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD, got: ${since}`)
  }
  return {
    projectDir: projectDir ?? defaultProjectDir(),
    since,
    examples,
    asJson,
  }
}

function main(): void {
  const argvRaw = process.argv.slice(2)
  // Allow the space-separated form `--since 2026-08-17` too.
  const argv: string[] = []
  for (let i = 0; i < argvRaw.length; i++) {
    const arg = argvRaw[i]!
    if (arg === '--since' && argvRaw[i + 1] !== undefined) {
      argv.push(`--since=${argvRaw[++i]}`)
    } else {
      argv.push(arg)
    }
  }

  const { projectDir, since, examples, asJson } = parseArgs(argv)
  const stats = statSync(projectDir, { throwIfNoEntry: false })
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(`not a directory: ${projectDir}`)
  }

  const result = measureExploreRedundancy({ projectDir, since })
  const metrics = computeMetrics(result)
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ result, metrics }, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatReport(result, metrics, examples)}\n`)
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    return import.meta.url === new URL(process.argv[1], 'file://').href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
