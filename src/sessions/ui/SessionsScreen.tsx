import type { UUID } from 'crypto'
import React from 'react'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { type LiveSession, listLiveSessions } from 'src/sessions/concurrentSessions.js'
import { saveCustomTitle } from 'src/sessions/sessionStorage.js'
import { SessionPreview } from 'src/sessions/ui/SessionPreview.js'
import {
  buildSessionRows,
  type CurrentSession,
  filterSessionRows,
  layoutSessionLines,
  scrollStartFor,
  type SessionRow,
} from 'src/sessions/ui/sessionRows.js'
import { SESSION_LINE_ROWS, SessionsTable } from 'src/sessions/ui/SessionsTable.js'
import { logError } from 'src/shared/log.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { useIsInsideModal, useModalOrTerminalSize } from 'src/terminal/contexts/modalContext.js'
import { useRegisterOverlay } from 'src/terminal/contexts/overlayContext.js'
import { Pane } from 'src/terminal/design-system/Pane.js'
import { useExitOnCtrlCDWithKeybindings } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from 'src/terminal/hooks/useSearchInput.js'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { Box, Text, useInput, useTerminalFocus } from 'src/terminal/ink.js'
import { SearchBox } from 'src/terminal/SearchBox.js'
import TextInput from 'src/terminal/text-input/TextInput.js'
import { getBranch } from 'src/vcs/git/git.js'

/** Header, search box, column header, the gap and status line, the hints. */
const CHROME_ROWS = 8
/** The Pane's own divider and the gap above it, drawn only outside the modal slot. */
const PANE_ROWS = 2
/** How often the list re-reads what runs here and in other instances. */
const REFRESH_MS = 1500

// Stable defaults: fresh literals would recompute the rows on every render.
const IDLE: CurrentSession = { turnActive: false, runningAgents: 0, costUSD: 0 }
const readIdle = (): CurrentSession => IDLE
const NO_SESSIONS: readonly string[] = []

type Mode = 'list' | 'search' | 'rename' | 'preview' | 'confirm'

export type SessionsScreenProps = {
  logs: readonly LogOption[]
  loading?: boolean
  /** The conversation this REPL is on; undefined in the startup picker. */
  currentSessionId?: string
  /** Live figures for the current session, fresher than its transcript; re-read while open. */
  readCurrent?: () => CurrentSession
  /** Sessions this process has visited, most recent first. */
  instanceSessionIds?: readonly string[]
  /** What switching would stop right now, in words; asked on each pick. */
  getRunningWork?: () => string | undefined
  onSelect: (log: LogOption) => void
  onCancel: () => void
  onLoadMore?: (count: number) => void
  onLogsChanged?: () => void
  showAllProjects: boolean
  onToggleAllProjects?: () => void
  initialSearchQuery?: string
  maxHeight?: number
  loadLiveSessions?: () => Promise<LiveSession[]>
}

/**
 * The session list: this conversation and the others visited in this
 * process (green), the ones another claudin has open (yellow — resuming them
 * here would put two writers on one transcript), and the rest (grey).
 */
export function SessionsScreen({
  logs,
  loading = false,
  currentSessionId,
  readCurrent = readIdle,
  instanceSessionIds = NO_SESSIONS,
  getRunningWork,
  onSelect,
  onCancel,
  onLoadMore,
  onLogsChanged,
  showAllProjects,
  onToggleAllProjects,
  initialSearchQuery,
  maxHeight,
  loadLiveSessions = listLiveSessions,
}: SessionsScreenProps): React.ReactNode {
  useRegisterOverlay('sessions-screen')
  const size = useModalOrTerminalSize(useTerminalSize())
  const insideModal = useIsInsideModal()
  const isTerminalFocused = useTerminalFocus()
  const height = maxHeight ?? size.rows
  const width = size.columns - (insideModal ? 2 : 4)
  const tableRows = height - CHROME_ROWS - (insideModal ? 0 : PANE_ROWS)
  const visibleLines = Math.max(2, Math.floor(tableRows / SESSION_LINE_ROWS))

  const [mode, setMode] = React.useState<Mode>('list')
  const [liveElsewhere, setLiveElsewhere] = React.useState<LiveSession[]>([])
  const [releasedCostUSD, setReleasedCostUSD] = React.useState<ReadonlyMap<string, number>>(
    () => new Map(),
  )
  const [notice, setNotice] = React.useState<string>()
  const [pending, setPending] = React.useState<{ log: LogOption; work: string }>()
  const [branch, setBranch] = React.useState<string>()
  const [branchOnly, setBranchOnly] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')
  const [renameCursor, setRenameCursor] = React.useState(0)
  const [focusedId, setFocusedId] = React.useState<string>()
  const [current, setCurrent] = React.useState(readCurrent)
  const startRef = React.useRef(0)

  // Re-read while open, so a turn that ends or an instance that goes idle
  // stops blinking, and costs keep up.
  React.useEffect(() => {
    let previous: LiveSession[] = []
    const onLive = (live: LiveSession[]): void => {
      const held = new Set(live.map(session => session.sessionId))
      const released = previous.filter(
        session => !held.has(session.sessionId) && session.costUSD !== undefined,
      )
      if (released.length > 0) {
        setReleasedCostUSD(known => {
          const next = new Map(known)
          for (const session of released) next.set(session.sessionId, session.costUSD!)
          return next
        })
      }
      previous = live
      setLiveElsewhere(live)
    }
    const refresh = (): void => {
      void loadLiveSessions().then(onLive, logError)
      setCurrent(readCurrent())
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [loadLiveSessions, readCurrent])
  React.useEffect(() => {
    void getBranch().then(setBranch, logError)
  }, [])

  const exitState = useExitOnCtrlCDWithKeybindings(onCancel, undefined, mode !== 'rename')
  const { query, setQuery, cursorOffset } = useSearchInput({
    isActive: mode === 'search',
    onExit: () => setMode('list'),
    onExitUp: () => setMode('list'),
    initialQuery: initialSearchQuery,
  })

  const allRows = React.useMemo(
    () =>
      buildSessionRows({
        logs,
        currentSessionId,
        instanceSessionIds,
        liveElsewhere,
        releasedCostUSD,
        current: branch ? { ...current, branch } : current,
        cwd: getOriginalCwd(),
        now: new Date(),
      }),
    [logs, currentSessionId, instanceSessionIds, liveElsewhere, releasedCostUSD, current, branch],
  )
  const rows = React.useMemo(() => {
    const onBranch = branchOnly && branch ? allRows.filter(row => row.log?.gitBranch === branch) : allRows
    return filterSessionRows(onBranch, query)
  }, [allRows, branchOnly, branch, query])
  const lines = React.useMemo(() => layoutSessionLines(rows), [rows])

  // Focus follows a session, not a position, so rows loading in or a filter
  // changing does not move it; it starts on the first session to switch to.
  const byId = rows.findIndex(row => row.sessionId === focusedId)
  const fallback = rows[0]?.status === 'current' && rows.length > 1 ? 1 : 0
  const focusedIndex = byId >= 0 ? byId : fallback
  const focused: SessionRow | undefined = rows[focusedIndex]
  const focusLine = lines.findIndex(line => line.kind === 'row' && line.index === focusedIndex)
  const start = scrollStartFor(startRef.current, Math.max(0, focusLine), visibleLines, lines.length)
  startRef.current = start

  React.useEffect(() => {
    if (onLoadMore && focusedIndex + visibleLines * 2 >= rows.length) {
      onLoadMore(visibleLines * 3)
    }
  }, [focusedIndex, rows.length, visibleLines, onLoadMore])

  async function choose(row: SessionRow): Promise<void> {
    if (row.status === 'current') {
      onCancel()
      return
    }
    if (!row.log) return
    // Re-read at the moment of choosing: another claudin may have opened it
    // since the list was drawn.
    const live = await loadLiveSessions()
    setLiveElsewhere(live)
    const holder = live.find(session => session.sessionId === row.sessionId)
    if (holder) {
      setNotice(`Open in another claudin (pid ${holder.pid}, ${holder.cwd}). Quit it there to continue here.`)
      return
    }
    const work = getRunningWork?.()
    if (work) {
      setPending({ log: row.log, work })
      setMode('confirm')
      return
    }
    onSelect(row.log)
  }

  async function submitRename(value: string): Promise<void> {
    const title = value.trim()
    if (focused?.log && title) {
      await saveCustomTitle(focused.sessionId as UUID, title, focused.log.fullPath)
      onLogsChanged?.()
    }
    setRenameValue('')
    setMode('list')
  }

  function move(delta: number): void {
    const next = rows[Math.max(0, Math.min(rows.length - 1, focusedIndex + delta))]
    if (next) setFocusedId(next.sessionId)
  }

  useInput(
    (input, key) => {
      if (mode === 'confirm') {
        if (key.return && pending) onSelect(pending.log)
        else if (key.escape) {
          setPending(undefined)
          setMode('list')
        }
        return
      }
      if (mode === 'rename') {
        if (key.escape) {
          setRenameValue('')
          setMode('list')
        }
        return
      }
      setNotice(undefined)
      if (key.upArrow) move(-1)
      else if (key.downArrow) move(1)
      else if (key.return) {
        if (focused) void choose(focused)
      } else if (key.escape) onCancel()
      else if (key.ctrl) {
        const letter = input.toLowerCase()
        if (letter === 'a') onToggleAllProjects?.()
        else if (letter === 'b' && branch) setBranchOnly(on => !on)
        else if (letter === 'v' && focused?.log) setMode('preview')
        else if (letter === 'r' && focused?.log) {
          setRenameValue('')
          setRenameCursor(0)
          setMode('rename')
        }
      } else if (input === '/') setMode('search')
      else if (input && !key.meta && !key.tab) {
        setQuery(query + input)
        setMode('search')
      }
    },
    { isActive: mode === 'list' || mode === 'confirm' || mode === 'rename' },
  )

  if (mode === 'preview' && focused?.log) {
    return (
      <SessionPreview
        log={focused.log}
        onExit={() => setMode('list')}
        onSelect={() => {
          setMode('list')
          void choose(focused)
        }}
      />
    )
  }

  const filters = [
    showAllProjects ? 'all projects' : undefined,
    branchOnly && branch ? `branch ${branch}` : undefined,
  ].filter(Boolean)

  const status =
    mode === 'rename' && focused ? (
      <Box flexDirection="row">
        <Text>Rename: </Text>
        <TextInput
          value={renameValue}
          onChange={setRenameValue}
          onSubmit={value => void submitRename(value)}
          placeholder={focused.title}
          columns={Math.max(10, width - 8)}
          cursorOffset={renameCursor}
          onChangeCursorOffset={setRenameCursor}
          showCursor
        />
      </Box>
    ) : mode === 'confirm' && pending ? (
      <Text color="warning">Switching stops {pending.work} in this session. Enter to switch · Esc to stay</Text>
    ) : notice ? (
      <Text color="warning">{notice}</Text>
    ) : loading ? (
      <Text dimColor>Loading sessions…</Text>
    ) : rows.length === 0 ? (
      <Text dimColor>{query ? 'No sessions match.' : 'No sessions yet.'}</Text>
    ) : (
      <Text> </Text>
    )

  const hints = exitState.pending
    ? `Press ${exitState.keyName} again to exit`
    : mode === 'search'
      ? 'Type to search · Enter/↓ to the list · Esc clear'
      : mode === 'rename'
        ? 'Enter save · Esc cancel'
        : [
            '↑↓ select · Enter open · type to search',
            onToggleAllProjects ? `Ctrl+A ${showAllProjects ? 'this project' : 'all projects'}` : undefined,
            branch ? 'Ctrl+B branch' : undefined,
            'Ctrl+V preview · Ctrl+R rename · Esc close',
          ]
            .filter(Boolean)
            .join(' · ')

  return (
    <Pane color="suggestion">
      <Box flexDirection="column">
        <Text>
          <Text bold color="suggestion">
            Sessions
          </Text>
          <Text dimColor>
            {rows.length > 0 ? ` (${focusedIndex + 1} of ${rows.length})` : ''}
            {filters.length > 0 ? ` · ${filters.join(' · ')}` : ''}
          </Text>
        </Text>
        <SearchBox
          query={query}
          placeholder="Search…"
          isFocused={mode === 'search'}
          isTerminalFocused={isTerminalFocused}
          cursorOffset={cursorOffset}
        />
        <SessionsTable
          rows={rows}
          lines={lines}
          focusedIndex={focusedIndex}
          start={start}
          height={visibleLines}
          width={width}
        />
        <Box marginTop={1}>{status}</Box>
        <Text dimColor>{hints}</Text>
      </Box>
    </Pane>
  )
}
