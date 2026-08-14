import chalk from 'chalk'
import type { StructuredPatchHunk } from 'diff'
import { resolve } from 'path'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandResultDisplay } from 'src/commands.js'
import { useRegisterOverlay } from 'src/context/overlayContext.js'
import { useCommitFiles } from 'src/hooks/useCommitFiles.js'
import type { DiffFile } from 'src/hooks/useDiffData.js'
import { useGitLog } from 'src/hooks/useGitLog.js'
import { useGitStashes } from 'src/hooks/useGitStashes.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { type TurnDiff, useTurnDiffs } from 'src/hooks/useTurnDiffs.js'
import { useWorkspaceDiff } from 'src/hooks/useWorkspaceDiff.js'
import { Box, Text, useInput, useTheme } from 'src/ink.js'
import { useKeybindings } from 'src/keybindings/useKeybinding.js'
import { type AppState, useAppState } from 'src/state/AppState.js'
import {
  getAheadBehind,
  getBranch,
  getFileStatus,
  resolveWorkspaceRoots,
} from 'src/services/git/git.js'
import { getCwd } from 'src/utils/fs/cwd.js'
import { readFileSafe } from 'src/utils/fs/file.js'
import { isFullscreenEnvEnabled } from 'src/utils/fullscreen.js'
import { buildAddedFileHunks } from 'src/services/git/gitDiff.js'
import { Dialog } from 'src/components/design-system/Dialog.js'
import { buildDiffRenderModel } from './collapse.js'
import { CommitFileList } from './CommitFileList.js'
import { CommitGraph } from './CommitGraph.js'
import {
  buildTreeRows,
  DiffFileList,
  flattenGroupFiles,
  INLINE_LIST_WIDTH,
  type TreeRow,
} from './DiffFileList.js'
import { DiffPane, renderDiffRows } from './DiffPane.js'
import type { DiffSegment, DiffSource, RepoGroup } from './types.js'

type Props = {
  messages: Parameters<typeof useTurnDiffs>[0]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type Tab = 'local' | 'log'
type Focus = 'list' | 'content'

/** Wrap a plain label as a top-aligned border title. */
function paneTitle(text: string): {
  content: string
  position: 'top'
  align: 'start'
} {
  return { content: ` ${text} `, position: 'top', align: 'start' }
}

type Selected = { file: DiffFile; hunks: StructuredPatchHunk[]; root: string }

function turnToGroup(turn: TurnDiff): RepoGroup {
  const files: DiffFile[] = [...turn.files.values()]
    .map(f => ({
      path: f.filePath,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: f.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const hunks = new Map<string, StructuredPatchHunk[]>()
  for (const f of turn.files.values()) hunks.set(f.filePath, f.hunks)
  return { root: getCwd(), name: '', branch: '', files, hunks }
}

/**
 * Right-aligned border-title item showing the selected file's add/remove
 * counts (or binary/large), pre-rendered with ANSI so it can sit on the diff
 * pane's top border. Returns null when there's nothing to show.
 */
function statsBorderText(
  file: DiffFile,
): { content: string; position: 'top'; align: 'end' } | null {
  let body: string
  if (file.isBinary) body = chalk.italic('binary')
  else if (file.isLargeFile) body = chalk.italic('large')
  else {
    const parts: string[] = []
    if (file.linesAdded > 0) parts.push(chalk.green(`+${file.linesAdded}`))
    if (file.linesRemoved > 0) parts.push(chalk.red(`-${file.linesRemoved}`))
    if (parts.length === 0) return null
    body = parts.join(' ')
  }
  return { content: ` ${body} `, position: 'top', align: 'end' }
}

function adjacentCommitRow(
  rows: { isCommit: boolean }[],
  from: number,
  dir: 1 | -1,
): number {
  let i = from + dir
  while (i >= 0 && i < rows.length) {
    if (rows[i]!.isCommit) return i
    i += dir
  }
  return from
}

/**
 * Page the Log selection by `delta` rows and land on a commit row — the graph
 * interleaves non-commit continuation rows, so a raw index jump can settle on
 * a row with no commit to show. Searches past the target in the paging
 * direction first, then back; stays put when neither finds one.
 */
function pageCommitRow(
  rows: { isCommit: boolean }[],
  from: number,
  delta: number,
): number {
  if (rows.length === 0) return from
  const target = Math.max(0, Math.min(rows.length - 1, from + delta))
  if (rows[target]!.isCommit) return target
  const dir = delta >= 0 ? 1 : -1
  const forward = adjacentCommitRow(rows, target, dir)
  if (forward !== target) return forward
  const back = adjacentCommitRow(rows, target, dir === 1 ? -1 : 1)
  return back !== target ? back : from
}

export function DiffDialog({ messages, onDone }: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  useRegisterOverlay('diff-dialog', true)

  // ── scope ───────────────────────────────────────────────────────────────
  // Resolve the repos in scope from app state (cwd repo + /add-dir roots).
  const additionalWorkingDirectories = useAppState(
    (s: AppState) => s.toolPermissionContext.additionalWorkingDirectories,
  )
  const roots = useMemo(
    () =>
      resolveWorkspaceRoots(getCwd(), [
        ...additionalWorkingDirectories.keys(),
      ]),
    [additionalWorkingDirectories],
  )
  // Raw directories to scan for nested child repos (monorepo): the cwd plus any
  // /add-dir roots, even when they are not git repos themselves.
  const scanBases = useMemo(
    () => [getCwd(), ...additionalWorkingDirectories.keys()],
    [additionalWorkingDirectories],
  )

  // ── data ────────────────────────────────────────────────────────────────
  const workspace = useWorkspaceDiff(roots, scanBases)
  // Prefer an explicit repo root for the Log/stash tabs; fall back to the first
  // discovered nested repo when the cwd itself is a bare monorepo container.
  const cwdRoot = roots[0] ?? workspace.roots[0]
  const turnDiffs = useTurnDiffs(messages)

  // Log tab can target any repo in scope (monorepo project selector). The list
  // mirrors the Local-tab grouping; index 0 is the cwd repo / first discovered.
  const [logRepoIndex, setLogRepoIndex] = useState(0)
  const logRepos = useMemo(
    () => workspace.groups.map(g => ({ root: g.root, name: g.name })),
    [workspace.groups],
  )
  const logRepo = logRepos.length
    ? logRepos[Math.min(logRepoIndex, logRepos.length - 1)]!
    : undefined
  const logRoot = logRepo?.root ?? cwdRoot

  const gitLog = useGitLog(logRoot)
  const stashes = useGitStashes(cwdRoot)

  // ── state ───────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>('local')
  const [focus, setFocus] = useState<Focus>('list')
  const [sourceIndex, setSourceIndex] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Keys (root\0relPath) of collapsed folders in the Local Changes tree.
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const [logSelectedRow, setLogSelectedRow] = useState(0)
  const [revealed, setRevealed] = useState<Map<string, number>>(new Map())
  const [expandAll, setExpandAll] = useState(false)
  const [diffScroll, setDiffScroll] = useState(0)
  const [logFilesScroll, setLogFilesScroll] = useState(0)
  const [stashDetail, setStashDetail] = useState<{
    ref: string
    group: RepoGroup
  } | null>(null)
  const [status, setStatus] = useState<{
    branch: string
    ahead: number
    behind: number
    dirty: number
  } | null>(null)
  const [statusNonce, setStatusNonce] = useState(0)
  const [theme] = useTheme()

  // ── layout ──────────────────────────────────────────────────────────────
  const split = isFullscreenEnvEnabled() && columns >= 100
  const leftWidth = Math.max(30, Math.min(50, Math.round(columns * 0.3)))
  // Dialog chrome costs 10 rows on the Local tab: Pane paddingTop+divider (2),
  // and the Dialog content column lays out [title, sourceLine, body, footer]
  // with gap={1} BETWEEN each (title + 3 gaps + sourceLine + footer = 6) plus
  // the pane border (2). Leave a 2-row bottom margin so the footer stays on
  // screen — without it a full-height overlay pushes its own top (and footer)
  // off-screen in inline / main-screen mode.
  const contentHeight = Math.max(6, rows - 12)
  // Both panes are pinned to this height so the dialog frame is CONSTANT
  // regardless of the selected file's diff length (a short diff must not
  // shrink the frame, a long one must not grow it).
  const paneHeight = contentHeight + 2
  // Side-by-side the body shares its row with the file list; stacked it spans
  // the dialog's inner width (Pane's paddingX={2}).
  const diffWidth = split
    ? Math.max(20, columns - leftWidth - 10)
    : Math.max(20, columns - 4)
  // Reserve 2 rows for the file list's ↑/↓ "more" indicators so the list never
  // overflows its (contentHeight-tall) inner area.
  // Inline (no side pane) the list stands in for the diff body, which already
  // uses the same budget — so it gets the same height instead of a fixed 15,
  // which both wasted a tall terminal and overflowed a short one.
  const listMaxVisible = Math.max(3, contentHeight - 2)
  // Viewport height for the scrollable body. Stacked there is no pane border to
  // carry the file name and scroll position, so a header row does — and that
  // row comes out of the body's budget.
  const bodyHeight = split ? contentHeight : Math.max(3, contentHeight - 1)

  // ── sources ─────────────────────────────────────────────────────────────
  const sources = useMemo<DiffSource[]>(
    () => [
      { type: 'working' },
      ...turnDiffs.map(turn => ({ type: 'turn' as const, turn })),
      ...stashes.entries.map(e => ({
        type: 'stash' as const,
        ref: e.ref,
        subject: e.subject,
      })),
    ],
    [turnDiffs, stashes.entries],
  )
  const currentSource = sources[Math.min(sourceIndex, sources.length - 1)] ?? {
    type: 'working',
  }

  // Load a stash's files + diff when it becomes the active source.
  useEffect(() => {
    if (currentSource.type !== 'stash') return
    if (stashDetail?.ref === currentSource.ref) return
    let cancelled = false
    void stashes.loadStash(currentSource.ref).then(detail => {
      if (cancelled) return
      const files: DiffFile[] = detail.files
        .map(f => ({
          path: f.path,
          linesAdded: f.added,
          linesRemoved: f.removed,
          isBinary: f.isBinary,
          isLargeFile: false,
          isTruncated: false,
        }))
        .sort((a, b) => a.path.localeCompare(b.path))
      setStashDetail({
        ref: currentSource.ref,
        group: {
          root: getCwd(),
          name: '',
          branch: '',
          files,
          hunks: detail.hunks,
        },
      })
    })
    return () => {
      cancelled = true
    }
  }, [currentSource, stashes, stashDetail])

  const currentGroups = useMemo<RepoGroup[]>(() => {
    if (currentSource.type === 'working') return workspace.groups
    if (currentSource.type === 'turn') return [turnToGroup(currentSource.turn)]
    return stashDetail?.ref === currentSource.ref ? [stashDetail.group] : []
  }, [currentSource, workspace.groups, stashDetail])

  const allFiles = useMemo(
    () => flattenGroupFiles(currentGroups),
    [currentGroups],
  )
  // The collapse-aware visible row list (folders + files). Selection indexes
  // this list; `selected` is non-null only when the highlighted row is a file.
  const treeRows = useMemo<TreeRow[]>(
    () => buildTreeRows(currentGroups, collapsedDirs),
    [currentGroups, collapsedDirs],
  )
  const selectedRow = treeRows[selectedIndex] ?? null
  // Dir and group rows share the same collapse machinery (toggle by `key`).
  const collapsibleRow =
    selectedRow &&
    (selectedRow.kind === 'dir' || selectedRow.kind === 'group')
      ? selectedRow
      : null
  const selected = useMemo<Selected | null>(
    () =>
      selectedRow?.kind === 'file'
        ? {
            file: selectedRow.file,
            hunks: selectedRow.hunks,
            root: selectedRow.root,
          }
        : null,
    [selectedRow],
  )

  const toggleDir = (key: string): void =>
    setCollapsedDirs(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Working-tree file text powers the collapse/expand context (and, for
  // untracked files, the synthetic all-green hunk below); unavailable — and
  // thus fail-open — for turns/stashes and binary/large files.
  const fileContent = useMemo(() => {
    if (!selected || currentSource.type !== 'working') return undefined
    const f = selected.file
    if (f.isBinary || f.isLargeFile) return undefined
    return readFileSafe(resolve(selected.root || getCwd(), f.path)) ?? undefined
  }, [selected, currentSource])
  const firstLine = fileContent?.split('\n')[0] ?? null

  // `git diff HEAD` omits untracked files, so they have no real hunks. Render
  // their full content as an all-added (green) diff instead — unless the
  // content looks binary (a NUL byte; fetchUntrackedFiles can't detect binary),
  // in which case we leave the hunks empty and fall back to a message.
  const isUntrackedFile = !!selected?.file.isUntracked
  const effectiveHunks = useMemo<StructuredPatchHunk[]>(() => {
    if (isUntrackedFile && fileContent != null) {
      if (fileContent.slice(0, 8000).includes('\u0000')) return []
      return buildAddedFileHunks(fileContent)
    }
    return selected?.hunks ?? []
  }, [isUntrackedFile, fileContent, selected])

  const segments = useMemo<DiffSegment[]>(
    () =>
      buildDiffRenderModel(
        effectiveHunks,
        // An all-added file has no unchanged context to collapse; passing
        // undefined renders the hunk verbatim (the file content still drives
        // syntax highlighting via renderDiffRows below).
        isUntrackedFile ? undefined : fileContent,
        revealed,
        expandAll,
      ),
    [effectiveHunks, isUntrackedFile, fileContent, revealed, expandAll],
  )

  // Pre-render the diff to final wrapped rows so the body can be windowed to a
  // fixed height (see DiffPane). Owning the row count here lets us clamp the
  // scroll offset and show a scroll position in the pane title.
  const diffRows = useMemo(
    () =>
      renderDiffRows(segments, {
        filePath: selected?.file.path ?? '',
        firstLine,
        fileContent,
        width: diffWidth,
        theme,
      }),
    [segments, selected, firstLine, fileContent, diffWidth, theme],
  )
  const maxDiffScroll = Math.max(0, diffRows.length - bodyHeight)
  const diffScrollClamped = Math.min(diffScroll, maxDiffScroll)
  const diffScrollLabel =
    maxDiffScroll > 0
      ? `${diffScrollClamped + 1}-${Math.min(
          diffRows.length,
          diffScrollClamped + bodyHeight,
        )}/${diffRows.length}`
      : ''

  // ── selection housekeeping ────────────────────────────────────────────────
  // Land on the first file row when a source's files first arrive and again
  // whenever the source changes. Keyed on the resolved sourceIndex (not on
  // `rows`/`currentGroups` identity) so a background workspace re-poll never
  // snaps the selection back while the user is navigating.
  const initRef = useRef<number | null>(null)
  useEffect(() => {
    if (allFiles.length === 0) return
    if (initRef.current === sourceIndex) return
    initRef.current = sourceIndex
    setCollapsedDirs(new Set())
    const fresh = buildTreeRows(currentGroups, new Set())
    const firstFile = fresh.findIndex(r => r.kind === 'file')
    setSelectedIndex(firstFile >= 0 ? firstFile : 0)
  }, [sourceIndex, allFiles, currentGroups])

  // Clamp the selection into range when the row list shrinks (e.g. after a
  // refresh or a folder collapse). Deliberately does NOT re-map by path — that
  // fought normal up/down navigation (the index would snap back every move).
  useEffect(() => {
    if (treeRows.length > 0 && selectedIndex >= treeRows.length) {
      setSelectedIndex(treeRows.length - 1)
    }
  }, [treeRows, selectedIndex])

  // Reset reveal + scroll to top when the selected file changes.
  const selectedKey = `${sourceIndex}:${selected?.file.path ?? ''}`
  useEffect(() => {
    setRevealed(new Map())
    setExpandAll(false)
    setDiffScroll(0)
  }, [selectedKey])

  // Initialize / keep the log selection on a commit row.
  useEffect(() => {
    if (gitLog.rows.length === 0) return
    const cur = gitLog.rows[logSelectedRow]
    if (!cur || !cur.isCommit) {
      const first = gitLog.rows.findIndex(r => r.isCommit)
      if (first >= 0) setLogSelectedRow(first)
    }
  }, [gitLog.rows, logSelectedRow])

  // Selected commit + its changed files (debounced). The files drive both the
  // right-pane list and the commit-wide +/- totals shown on the pane border.
  const selectedHash =
    gitLog.rows[logSelectedRow]?.isCommit
      ? gitLog.rows[logSelectedRow]!.hash
      : null
  const commitFiles = useCommitFiles(selectedHash, logRoot)
  const commitFileCount = commitFiles?.length ?? 0
  const maxLogFilesScroll = Math.max(0, commitFileCount - bodyHeight)
  const logFilesScrollClamped = Math.min(logFilesScroll, maxLogFilesScroll)
  const logScrollLabel =
    maxLogFilesScroll > 0
      ? `${logFilesScrollClamped + 1}-${Math.min(
          commitFileCount,
          logFilesScrollClamped + bodyHeight,
        )}/${commitFileCount}`
      : ''
  // Land back at the top of the file list when the selected commit changes.
  useEffect(() => {
    setLogFilesScroll(0)
  }, [selectedHash])
  const commitStats = useMemo(() => {
    if (!commitFiles || commitFiles.length === 0) return null
    let added = 0
    let removed = 0
    for (const f of commitFiles) {
      added += f.added
      removed += f.removed
    }
    return { added, removed }
  }, [commitFiles])

  // Footer status follows the repo currently in view: the selected Log project
  // on the Log tab, otherwise the cwd repo. Falls back to the ambient repo when
  // no explicit root is resolved.
  const statusRoot = activeTab === 'log' ? logRoot : cwdRoot
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [branch, ab, fs] = await Promise.all([
        getBranch(statusRoot),
        getAheadBehind(statusRoot),
        getFileStatus(statusRoot),
      ])
      if (!cancelled) {
        setStatus({
          branch,
          ahead: ab.ahead,
          behind: ab.behind,
          dirty: fs.tracked.length + fs.untracked.length,
        })
      }
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [statusNonce, statusRoot])

  // ── keybindings ───────────────────────────────────────────────────────────
  const expandNextGap = (): void => {
    const baseGaps = buildDiffRenderModel(
      selected?.hunks ?? [],
      fileContent,
    ).filter((s): s is Extract<DiffSegment, { kind: 'gap' }> => s.kind === 'gap')
    for (const gap of baseGaps) {
      const cur = revealed.get(gap.id) ?? 0
      if (cur < gap.lineCount) {
        setRevealed(prev => {
          const next = new Map(prev)
          next.set(gap.id, Math.min(gap.lineCount, cur + 10))
          return next
        })
        return
      }
    }
  }

  const refresh = (): void => {
    workspace.refresh()
    if (activeTab === 'log') gitLog.refresh()
    // Re-fetch stashes too (only if they were ever loaded), and drop the cached
    // active-stash detail so its files/hunks reload from disk.
    if (stashes.loaded) {
      stashes.refresh()
      if (currentSource.type === 'stash') setStashDetail(null)
    }
    setStatusNonce(n => n + 1)
    setRevealed(new Map())
    setExpandAll(false)
    setDiffScroll(0)
    setLogFilesScroll(0)
  }

  const handleCancel = (): void => {
    if (focus === 'content') setFocus('list')
    else onDone('Diff dialog dismissed', { display: 'system' })
  }

  useKeybindings(
    {
      'diff:nextTab': () => {
        const next = activeTab === 'local' ? 'log' : 'local'
        if (next === 'log') gitLog.ensureLoaded()
        setActiveTab(next)
        setFocus('list')
      },
      // ← : Diff/content pane → file list; on an expanded folder/group, collapse it.
      'diff:focusList': () => {
        if (focus === 'content') {
          setFocus('list')
          return
        }
        if (activeTab === 'local' && collapsibleRow && !collapsibleRow.collapsed) {
          toggleDir(collapsibleRow.key)
          return
        }
        return false
      },
      // → : file list → Diff/content pane; on a collapsed folder/group, expand it.
      'diff:focusContent': () => {
        if (focus !== 'list') return false
        if (activeTab === 'local' && collapsibleRow) {
          if (collapsibleRow.collapsed) toggleDir(collapsibleRow.key)
          return
        }
        setFocus('content')
      },
      // [ : previous source (Local: working tree/turns/stashes) or, on the Log
      //     tab, the previous project in a monorepo.
      'diff:previousSource': () => {
        if (focus !== 'list') return false
        if (activeTab === 'log') {
          if (logRepos.length <= 1) return false
          setLogRepoIndex(i => Math.max(0, i - 1))
          setLogSelectedRow(0)
          return
        }
        stashes.ensureLoaded()
        setSourceIndex(i => Math.max(0, i - 1))
      },
      // ] : next source / next Log project.
      'diff:nextSource': () => {
        if (focus !== 'list') return false
        if (activeTab === 'log') {
          if (logRepos.length <= 1) return false
          setLogRepoIndex(i => Math.min(logRepos.length - 1, i + 1))
          setLogSelectedRow(0)
          return
        }
        stashes.ensureLoaded()
        setSourceIndex(i => Math.min(sources.length - 1, i + 1))
      },
      'diff:previousFile': () => {
        if (focus === 'content') {
          // Content focused: ↑ scrolls the body, in BOTH layouts — the body is
          // windowed over pre-rendered rows and needs no alt-screen viewport.
          if (activeTab === 'local') {
            setDiffScroll(s => Math.max(0, s - 1))
            return
          }
          setLogFilesScroll(s => Math.max(0, s - 1))
          return
        }
        if (activeTab === 'local') setSelectedIndex(i => Math.max(0, i - 1))
        else setLogSelectedRow(r => adjacentCommitRow(gitLog.rows, r, -1))
      },
      'diff:nextFile': () => {
        if (focus === 'content') {
          if (activeTab === 'local') {
            setDiffScroll(s => Math.min(maxDiffScroll, s + 1))
            return
          }
          setLogFilesScroll(s => Math.min(maxLogFilesScroll, s + 1))
          return
        }
        if (activeTab === 'local') {
          setSelectedIndex(i => Math.min(treeRows.length - 1, i + 1))
        } else {
          const next = adjacentCommitRow(gitLog.rows, logSelectedRow, 1)
          if (next === logSelectedRow && gitLog.hasMore) gitLog.loadMore()
          setLogSelectedRow(next)
        }
      },
      // Enter: toggle a folder / open a file → content (list); grow the next
      // collapsed gap (content).
      'diff:viewDetails': () => {
        if (focus === 'list') {
          if (activeTab === 'local' && collapsibleRow) {
            toggleDir(collapsibleRow.key)
            return
          }
          setFocus('content')
          return
        }
        if (activeTab === 'local') {
          expandNextGap()
          return
        }
        return false
      },
      'diff:expandAll': () => {
        if (activeTab === 'local') setExpandAll(x => !x)
        else return false
      },
      'diff:refresh': refresh,
    },
    { context: 'DiffDialog' },
  )

  // Paging for whichever pane has focus, in BOTH layouts. Line-by-line ↑/↓ is
  // handled by the diff:previousFile/nextFile keybindings above; these keys
  // aren't bound there, so the keybinding resolver leaves them here.
  //
  // u/d are the advertised page keys because they reach this handler in every
  // render mode. PgUp/PgDn only reach it inline: in fullscreen the REPL mounts
  // ScrollKeybindingHandler, whose Scroll-context scroll:page* handlers always
  // consume (they stopImmediatePropagation before any dialog sees the key).
  useInput((input, key) => {
    const up = key.pageUp || input === 'u'
    const down = key.pageDown || input === 'd'
    const home = input === 'g'
    const end = input === 'G'
    if (!up && !down && !home && !end) return
    if (focus === 'list') {
      const page = listMaxVisible
      if (activeTab === 'local') {
        const last = Math.max(0, treeRows.length - 1)
        if (up) setSelectedIndex(i => Math.max(0, i - page))
        else if (down) setSelectedIndex(i => Math.min(last, i + page))
        else if (home) setSelectedIndex(0)
        else setSelectedIndex(last)
        return
      }
      const log = gitLog.rows
      const delta = up ? -page : down ? page : home ? -log.length : log.length
      setLogSelectedRow(r => pageCommitRow(log, r, delta))
      return
    }
    const page = bodyHeight
    if (activeTab === 'local') {
      if (up) setDiffScroll(s => Math.max(0, s - page))
      else if (down) setDiffScroll(s => Math.min(maxDiffScroll, s + page))
      else if (home) setDiffScroll(0)
      else setDiffScroll(maxDiffScroll)
      return
    }
    if (up) setLogFilesScroll(s => Math.max(0, s - page))
    else if (down)
      setLogFilesScroll(s => Math.min(maxLogFilesScroll, s + page))
    else if (home) setLogFilesScroll(0)
    else setLogFilesScroll(maxLogFilesScroll)
  })

  // ── render helpers ────────────────────────────────────────────────────────
  // No repo at all only once the scan has settled with zero groups — a nested
  // monorepo has no explicit root but still discovers child repos.
  const noRepo = !workspace.loading && workspace.groups.length === 0
  const tabBar = (
    <>
      <Text inverse={activeTab === 'local'} bold={activeTab === 'local'}>
        {' '}
        Local Changes{' '}
      </Text>
      {'  '}
      <Text inverse={activeTab === 'log'} bold={activeTab === 'log'}>
        {' '}
        Log{' '}
      </Text>
    </>
  )

  const sourceLabel =
    currentSource.type === 'working'
      ? 'working tree'
      : currentSource.type === 'turn'
        ? `T${currentSource.turn.turnIndex}`
        : currentSource.ref
  const sourceLine = activeTab === 'local' && (
    <Text dimColor>
      {`source: ${sourceLabel} ▾`}
      {sources.length > 1 ? '   [ ] source' : ''}
    </Text>
  )
  // Log tab: project picker, shown only when more than one repo is in scope.
  const projectLine = activeTab === 'log' && logRepos.length > 1 && (
    <Text dimColor>
      {`project: ${logRepo?.name ?? ''} ▾   [ ] project`}
    </Text>
  )

  const statusText = status
    ? `${status.branch}${status.ahead ? ` ↑${status.ahead}` : ''}${
        status.behind ? ` ↓${status.behind}` : ''
      } · ${status.dirty} changed`
    : ''
  const hints =
    activeTab === 'log'
      ? focus === 'content'
        ? 'Tab tabs · ↑/↓ scroll · u/d page · g/G ends · ← commits · Esc close'
        : `Tab tabs · ↑/↓ commits · u/d page · → files · ← back${
            logRepos.length > 1 ? ' · [ ] project' : ''
          } · r refresh · Esc close`
      : focus === 'content'
        ? 'Tab tabs · ↑/↓ scroll · u/d page · g/G ends · Enter expand gap · a expand all · ← files · Esc close'
        : 'Tab tabs · ↑/↓ move · u/d page · ←/→ folder · Enter open · [ ] source · a expand · r refresh · Esc close'
  const footer = (
    <Box flexDirection="row">
      <Text dimColor>{statusText}</Text>
      <Box flexGrow={1} />
      <Text dimColor>{hints}</Text>
    </Box>
  )

  const localEmptyMessage = workspace.loading
    ? 'Loading diff…'
    : currentSource.type === 'stash' && currentGroups.length === 0
      ? 'Loading stash…'
      : currentSource.type === 'turn'
        ? 'No file changes in this turn'
        : 'Working tree is clean'

  // Diff content for the right pane / stacked body. Windowed to `height` in
  // both layouts — the dialog owns the scroll offset.
  const renderDiffBody = (height: number): React.ReactNode => {
    if (!selected) {
      const hint =
        allFiles.length === 0
          ? localEmptyMessage
          : selectedRow?.kind === 'dir'
            ? 'Folder — Enter or ←/→ to collapse/expand'
            : 'Select a file to view its diff'
      return <Text dimColor>{hint}</Text>
    }
    const f = selected.file
    if (f.isBinary)
      return <Text dimColor italic>Binary file - cannot display diff</Text>
    if (f.isLargeFile)
      return <Text dimColor italic>Large file - diff exceeds 1 MB limit</Text>
    if (f.isUntracked && effectiveHunks.length === 0)
      return <Text dimColor italic>New file not yet staged.</Text>
    if (f.renamedFrom && effectiveHunks.length === 0)
      return <Text dimColor italic>{`renamed from ${f.renamedFrom}`}</Text>
    return (
      <DiffPane
        rows={diffRows}
        scrollOffset={diffScrollClamped}
        height={height}
        width={diffWidth}
      />
    )
  }

  /** Stands in for the pane border title in the stacked layout. */
  const stackedHeader = (title: string, label: string): React.ReactNode => (
    <Text>
      <Text bold>{title}</Text>
      {label ? <Text dimColor>{`  ${label}`}</Text> : null}
    </Text>
  )

  // ── body ────────────────────────────────────────────────────────────────
  let body: React.ReactNode
  if (noRepo) {
    body = (
      <Box marginTop={1}>
        <Text dimColor>Not a git repository</Text>
      </Box>
    )
  } else if (activeTab === 'local') {
    const listEl =
      allFiles.length === 0 ? (
        <Text dimColor>{localEmptyMessage}</Text>
      ) : (
        <DiffFileList
          rows={treeRows}
          selectedIndex={selectedIndex}
          maxVisible={listMaxVisible}
          width={split ? leftWidth - 2 : Math.min(columns - 4, INLINE_LIST_WIDTH)}
        />
      )
    body = split ? (
      <Box flexDirection="row" gap={1}>
        <Box
          width={leftWidth}
          flexShrink={0}
          height={paneHeight}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'list' ? 'permission' : 'subtle'}
          borderText={paneTitle('Files')}
        >
          {listEl}
        </Box>
        <Box
          flexGrow={1}
          height={paneHeight}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'content' ? 'permission' : 'subtle'}
          borderText={(() => {
            const title = paneTitle(
              selected
                ? `Diff: ${selected.file.path}${
                    selected.file.isTruncated ? ' (truncated)' : ''
                  }${diffScrollLabel ? `  ${diffScrollLabel}` : ''}`
                : 'Diff',
            )
            // Untracked files carry no git line counts; show the synthesized
            // all-added count so the new-file diff still reports +N.
            const statsFile =
              selected && isUntrackedFile && effectiveHunks.length > 0
                ? {
                    ...selected.file,
                    linesAdded: effectiveHunks[0]!.newLines,
                    linesRemoved: 0,
                  }
                : selected?.file
            const stats = statsFile ? statsBorderText(statsFile) : null
            return stats ? [title, stats] : title
          })()}
        >
          {renderDiffBody(bodyHeight)}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        {focus === 'list' ? (
          listEl
        ) : (
          <>
            {selected &&
              stackedHeader(
                `${selected.file.path}${
                  selected.file.isTruncated ? ' (truncated)' : ''
                }`,
                diffScrollLabel,
              )}
            {renderDiffBody(bodyHeight)}
          </>
        )}
      </Box>
    )
  } else {
    // Log tab
    const graphEl = (
      <CommitGraph
        rows={gitLog.rows}
        selectedRow={logSelectedRow}
        maxVisible={listMaxVisible}
        loading={gitLog.loading}
        hasMore={gitLog.hasMore}
      />
    )
    const filesEl = (
      <CommitFileList
        files={commitFiles}
        maxVisible={bodyHeight}
        scrollOffset={logFilesScrollClamped}
      />
    )
    const commitFilesTitle = selectedHash
      ? `Files in ${selectedHash.slice(0, 7)}`
      : 'Files'
    body = split ? (
      <Box flexDirection="row" gap={1}>
        <Box
          width={leftWidth}
          flexShrink={0}
          height={paneHeight}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'list' ? 'permission' : 'subtle'}
          borderText={paneTitle('Log')}
        >
          {graphEl}
        </Box>
        <Box
          flexGrow={1}
          height={paneHeight}
          overflow="hidden"
          flexDirection="column"
          borderColor={focus === 'content' ? 'permission' : 'subtle'}
          borderStyle="round"
          borderText={(() => {
            const title = paneTitle(
              `${commitFilesTitle}${
                logScrollLabel ? `  ${logScrollLabel}` : ''
              }`,
            )
            // Commit-wide add/remove totals, right-aligned like the Local diff
            // pane. Reuses statsBorderText via a synthetic stats-only file.
            const stats = commitStats
              ? statsBorderText({
                  path: '',
                  linesAdded: commitStats.added,
                  linesRemoved: commitStats.removed,
                  isBinary: false,
                  isLargeFile: false,
                  isTruncated: false,
                })
              : null
            return stats ? [title, stats] : title
          })()}
        >
          {filesEl}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        {focus === 'list' ? (
          graphEl
        ) : (
          <>
            {stackedHeader(commitFilesTitle, logScrollLabel)}
            {filesEl}
          </>
        )}
      </Box>
    )
  }

  return (
    <Dialog
      title={tabBar}
      onCancel={handleCancel}
      color="background"
      hideInputGuide
    >
      {sourceLine}
      {projectLine}
      {body}
      {footer}
    </Dialog>
  )
}
