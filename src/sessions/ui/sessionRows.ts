/**
 * The session list's rows, decided without rendering: which sessions are
 * open here, open in another claudin, or inactive, in what order, and what
 * each column says. SessionsScreen only lays these out.
 */
import { basename } from 'path'
import type { LiveSession } from 'src/sessions/concurrentSessions.js'
import { getSessionIdFromLog } from 'src/sessions/indexing/liteMetadata.js'
import type { SessionPresence } from 'src/sessions/sessionPresence.js'
import { getLogDisplayTitle } from 'src/shared/log.js'
import { formatRelativeTimeAgo, formatTokens } from 'src/shared/text/format.js'
import type { LogOption } from 'src/shared/types/logs.js'

/**
 * `current` is this conversation; `open` another session visited in this
 * process; `elsewhere` one a different claudin process has open, which must
 * not be resumed here; `inactive` everything else.
 */
export type SessionStatus = 'current' | 'open' | 'elsewhere' | 'inactive'

export type SessionRow = {
  sessionId: string
  /** Undefined only for the current session before its transcript exists. */
  log?: LogOption
  status: SessionStatus
  /** A turn or background agents running there now: its dot blinks. */
  running: boolean
  title: string
  /** Background agents running now; an inactive session has none. */
  agents: string
  /** The project or worktree the session ran in, and its branch. */
  where: string
  branch: string
  tokens: string
  cost: string
  when: string
  /** The process holding an `elsewhere` session. */
  holder?: { pid: number; cwd: string }
}

export type SessionRowsInput = {
  logs: readonly LogOption[]
  /** Undefined where there is no conversation yet (the startup picker). */
  currentSessionId: string | undefined
  /** Sessions visited in this process, most recent first. */
  instanceSessionIds: readonly string[]
  liveElsewhere: readonly LiveSession[]
  /**
   * The last cost seen live for sessions another instance has since let go:
   * the list was read before that instance stamped it into the transcript.
   */
  releasedCostUSD?: ReadonlyMap<string, number>
  /** Live figures for the current session, fresher than its transcript. */
  current: CurrentSession
  cwd: string
  now: Date
}

export type CurrentSession = SessionPresence & {
  title?: string
  contextTokens?: number
  /** The branch checked out now, for the row a new session has before its transcript. */
  branch?: string
}

const STATUS_ORDER: Record<SessionStatus, number> = {
  current: 0,
  open: 1,
  elsewhere: 2,
  inactive: 3,
}

const NEWLINES_RE = /\s*\n\s*/g
const WHITESPACE_RE = /\s+/

/** No cost recorded reads as $0.00, like a session that spent nothing. */
function costLabel(costUSD: number | undefined): string {
  return `$${(costUSD ?? 0).toFixed(2)}`
}

/** A worktree by its name, anything else by its folder: `claudin`, `ui-test`. */
function whereLabel(log: LogOption, cwd: string): string {
  return log.worktreeSession?.worktreeName ?? basename(log.projectPath ?? cwd)
}

export function buildSessionRows(input: SessionRowsInput): SessionRow[] {
  const { currentSessionId, current, cwd, now } = input
  const instanceRank = new Map(
    input.instanceSessionIds.map((id, index) => [id, index]),
  )
  const holders = new Map(input.liveElsewhere.map(live => [live.sessionId, live]))

  const rows: SessionRow[] = []
  const seen = new Set<string>()
  for (const log of input.logs) {
    const sessionId = getSessionIdFromLog(log)
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    const isCurrent = sessionId === currentSessionId
    const holder = isCurrent ? undefined : holders.get(sessionId)
    const status: SessionStatus = isCurrent
      ? 'current'
      : holder
        ? 'elsewhere'
        : instanceRank.has(sessionId)
          ? 'open'
          : 'inactive'
    const contextTokens = isCurrent
      ? (current.contextTokens ?? log.contextTokens)
      : log.contextTokens
    // Only a live process knows what runs in a session: this one for its
    // current session, the holder's PID record for one open elsewhere.
    const presence = isCurrent ? current : holder
    const runningAgents = presence?.runningAgents ?? 0
    rows.push({
      sessionId,
      log,
      status,
      running: Boolean(presence?.turnActive) || runningAgents > 0,
      title: (
        (isCurrent ? current.title : undefined) ?? getLogDisplayTitle(log)
      ).replace(NEWLINES_RE, ' '),
      agents: String(runningAgents),
      where: whereLabel(log, cwd),
      branch: log.gitBranch ?? '',
      tokens: contextTokens ? formatTokens(contextTokens) : '',
      cost: costLabel(
        presence?.costUSD ??
          input.releasedCostUSD?.get(sessionId) ??
          log.costUSD ??
          log.costState?.totalCostUSD,
      ),
      when: formatRelativeTimeAgo(log.modified, { now }),
      holder: holder ? { pid: holder.pid, cwd: holder.cwd } : undefined,
    })
  }

  if (currentSessionId !== undefined && !seen.has(currentSessionId)) {
    rows.push({
      sessionId: currentSessionId,
      status: 'current',
      running: current.turnActive || current.runningAgents > 0,
      title: current.title ?? '(new session)',
      agents: String(current.runningAgents),
      where: basename(cwd),
      branch: current.branch ?? '',
      tokens: current.contextTokens ? formatTokens(current.contextTokens) : '',
      cost: costLabel(current.costUSD),
      when: 'now',
    })
  }

  const modifiedAt = (row: SessionRow): number => row.log?.modified.getTime() ?? now.getTime()
  return rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.status === 'open'
        ? instanceRank.get(a.sessionId)! - instanceRank.get(b.sessionId)!
        : modifiedAt(b) - modifiedAt(a)),
  )
}

/**
 * Rows matching every whitespace-separated term of `query`, case-insensitive,
 * over the title, the place and the first prompt, tag and PR behind them.
 */
export function filterSessionRows(
  rows: readonly SessionRow[],
  query: string,
): SessionRow[] {
  const terms = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean)
  if (terms.length === 0) return [...rows]
  return rows.filter(row => {
    const log = row.log
    const haystack = [
      row.title,
      row.where,
      row.branch,
      log?.firstPrompt,
      log?.tag,
      log?.prRepository && log.prNumber ? `${log.prRepository}#${log.prNumber}` : undefined,
      row.sessionId,
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

/** A table line: a session, or the rule above the first inactive one. */
export type SessionLine = { kind: 'row'; index: number } | { kind: 'divider' }

/** The rule only separates: it shows when an open session sits above it. */
export function layoutSessionLines(rows: readonly SessionRow[]): SessionLine[] {
  const lines: SessionLine[] = []
  rows.forEach((row, index) => {
    if (row.status === 'inactive' && index > 0 && rows[index - 1]!.status !== 'inactive') {
      lines.push({ kind: 'divider' })
    }
    lines.push({ kind: 'row', index })
  })
  return lines
}

/**
 * The first line to show so `focusLine` stays in a window of `height`,
 * moving the window only as far as it must from where it was.
 */
export function scrollStartFor(
  previousStart: number,
  focusLine: number,
  height: number,
  total: number,
): number {
  let start = previousStart
  if (focusLine < start) start = focusLine
  else if (focusLine >= start + height) start = focusLine - height + 1
  return Math.max(0, Math.min(start, total - height))
}

/** What a switch would stop, in words, or undefined when nothing runs. */
export function describeRunningWork(work: {
  busy: boolean
  runningAgents: number
}): string | undefined {
  const parts: string[] = []
  if (work.busy) parts.push('the running turn')
  if (work.runningAgents > 0) {
    parts.push(
      `${work.runningAgents} background agent${work.runningAgents === 1 ? '' : 's'}`,
    )
  }
  return parts.length > 0 ? parts.join(' and ') : undefined
}
