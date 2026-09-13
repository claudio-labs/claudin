import chalk from 'chalk'
import { getTheme, themeColorToAnsi } from 'src/terminal/theme/theme.js'
import type { StructuredPatchHunk } from 'diff'
import { basename, relative, resolve } from 'path'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandResultDisplay } from 'src/commands/commands.js'
import { useRegisterOverlay } from 'src/terminal/contexts/overlayContext.js'
import { useCommitDiff } from 'src/vcs/diff/hooks/useCommitDiff.js'
import { useCommitFiles } from 'src/vcs/diff/hooks/useCommitFiles.js'
import type { DiffFile } from 'src/vcs/diff/hooks/useDiffData.js'
import { useGitLog } from 'src/vcs/hooks/useGitLog.js'
import { useGitStashes } from 'src/vcs/hooks/useGitStashes.js'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { type TurnDiff, useTurnDiffs } from 'src/vcs/diff/hooks/useTurnDiffs.js'
import { useWorkspaceDiff } from 'src/vcs/diff/hooks/useWorkspaceDiff.js'
import { Box, type DOMElement, Text, useInput, useTheme } from 'src/terminal/ink.js'
import { useKeybindings } from 'src/terminal/keybindings/useKeybinding.js'
import { type AppState, useAppState } from 'src/terminal/state/AppState.js'
import {
  getAheadBehind,
  getBranch,
  getFileStatus,
  resolveWorkspaceRoots,
} from 'src/vcs/git/git.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { readFileSafe } from 'src/shared/fs/file.js'
import { plural } from 'src/shared/text/stringUtils.js'
import { buildAddedFileHunks } from 'src/vcs/git/gitDiff.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import {
  useIsInsideModal,
  useModalOrTerminalSize,
} from 'src/terminal/contexts/modalContext.js'
import { useSidePanel } from 'src/terminal/contexts/sidePanelContext.js'
import { computeTakeoverLayout } from 'src/vcs/diff/ui/layout.js'
import { buildDiffRenderModel } from 'src/vcs/diff/ui/collapse.js'
import { CommitFileList } from 'src/vcs/diff/ui/CommitFileList.js'
import { CommitGraph } from 'src/vcs/diff/ui/CommitGraph.js'
import {
  buildTreeRows,
  DiffFileList,
  flattenGroupFiles,
  INLINE_LIST_WIDTH,
  type TreeRow,
} from 'src/vcs/diff/ui/DiffFileList.js'
import { DiffPane, renderDiffRows } from 'src/vcs/diff/ui/DiffPane.js'
import { buildRowLineIndex, selectionRange } from 'src/vcs/diff/ui/rowLines.js'
import { useDiffSelectionMention } from 'src/vcs/diff/ui/useDiffSelectionMention.js'
import type { DiffSegment, DiffSource, RepoGroup } from 'src/vcs/diff/ui/types.js'

type Props = {
  messages: Parameters<typeof useTurnDiffs>[0]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type Tab = 'local' | 'log'
type Focus = 'list' | 'content'

/** Columns DiffPane reserves for its cursor / selection marker. */
const DIFF_GUTTER_WIDTH = 2

/**
 * Join `parts` with ` · ` into at most `width` columns, dropping from the tail
 * — they are ordered most-useful-first. `always` is appended even when the
 * budget is already spent, so the closing key never disappears.
 */
function fitHints(parts: string[], width: number, always: string): string {
  const tail = always ? ` · ${always}` : ''
  const budget = Math.max(0, width - tail.length)
  let out = ''
  for (const part of parts) {
    const next = out ? `${out} · ${part}` : part
    if (next.length > budget) break
    out = next
  }
  return out ? `${out}${tail}` : always
}

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
  // As a side panel the chat is still on screen and its prompt is typable, so
  // the dialog only claims the keyboard while it holds focus: registering the
  // overlay is what blanks `focus` on the prompt's TextInput (and with it every
  // keystroke), and the same flag gates our keybindings below. Outside the
  // split — inline, or the narrow-terminal takeover — useSidePanel() is null
  // and this is unconditionally true, exactly as before.
  const sidePanel = useSidePanel()
  const hasFocus = sidePanel === null || sidePanel.focus === 'panel'
  useRegisterOverlay('diff-dialog', hasFocus)

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
  // Local Changes, diff focused: the highlighted RENDERED row, and the row `v`
  // anchored a visual line selection at (null = no selection).
  const [cursorRow, setCursorRow] = useState(0)
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null)
  // Log tab, level 2 + 3: which file of the selected commit is highlighted,
  // whether its diff is open, and that diff's scroll offset.
  const [logFileIndex, setLogFileIndex] = useState(0)
  const [logDiffOpen, setLogDiffOpen] = useState(false)
  const [logDiffScroll, setLogDiffScroll] = useState(0)
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
  // The side panel paints its own background, and the pre-rendered diff rows
  // have to carry it themselves — see DiffPane's `backgroundSgr`.
  const panelBackground = getTheme(theme).sidePanelBackground
  const panelBackgroundSgr = panelBackground
    ? themeColorToAnsi(panelBackground, true)
    : null

  // ── layout ──────────────────────────────────────────────────────────────
  // Inside the modal slot the dialog owns a full-height surface: the whole
  // terminal under the takeover, or the right half as a side panel. That is
  // also exactly the fullscreen case, since the REPL routes every local-jsx
  // command to the modal slot there.
  const takeover = useIsInsideModal()
  // EVERY dimension comes from the modal context, never from the terminal: as
  // a side panel the dialog is half a screen wide and stops above the
  // full-width prompt, while useTerminalSize() still reports the whole
  // terminal. Terminal-derived numbers render past the divider (clipped
  // instead of wrapped) and past the bottom (the footer disappears). The
  // fallbacks are what the inline path used before.
  const usableSize = useModalOrTerminalSize({
    columns: columns - 4,
    rows,
  })
  const usableColumns = usableSize.columns
  // Only the Log tab is side-by-side now: its left rail is the git graph, which
  // needs the columns. Local Changes stacks the file list ON TOP of the diff,
  // so it works at any width and drops the gate.
  const split = takeover && activeTab === 'log' && usableColumns >= 96
  const leftWidth = Math.max(30, Math.min(50, Math.round(usableColumns * 0.3)))
  // Dialog chrome costs 10 rows on the Local tab: Pane paddingTop+divider (2),
  // and the Dialog content column lays out [title, sourceLine, body, footer]
  // with gap={1} BETWEEN each (title + 3 gaps + sourceLine + footer = 6) plus
  // the pane border (2). Leave a 2-row bottom margin so the footer stays on
  // screen — without it a full-height overlay pushes its own top (and footer)
  // off-screen in inline / main-screen mode.
  // Under the takeover that margin is unnecessary (the pane is exactly `rows`
  // tall and clipped) and the peek + divider are gone, so 3 rows come back.
  const contentHeight = Math.max(6, usableSize.rows - (takeover ? 9 : 12))
  // Both panes are pinned to this height so the dialog frame is CONSTANT
  // regardless of the selected file's diff length (a short diff must not
  // shrink the frame, a long one must not grow it).
  const paneHeight = contentHeight + 2

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

  // ── layout, part 2 (needs treeRows) ───────────────────────────────────────
  // Local Changes under the takeover: the Files pane auto-fits the changed
  // files (capped) and the Diff pane takes what's left.
  const stacked = takeover && activeTab === 'local'
  const takeoverLayout = computeTakeoverLayout(contentHeight, treeRows.length)
  // Side-by-side the body shares its row with the file list; otherwise it spans
  // the dialog's inner width. The Log split still pays for its pane border; the
  // stacked sections are borderless, so they only give back Pane's paddingX and
  // 2 columns of slack (the fullscreen indent bites width math).
  const diffWidth = split
    ? Math.max(20, usableColumns - leftWidth - 6)
    : stacked
      ? Math.max(20, usableColumns - 4)
      : Math.max(20, usableColumns)
  // Reserve 2 rows for the file list's ↑/↓ "more" indicators so the list never
  // overflows its (contentHeight-tall) inner area.
  // Inline (no side pane) the list stands in for the diff body, which already
  // uses the same budget — so it gets the same height instead of a fixed 15,
  // which both wasted a tall terminal and overflowed a short one.
  const listMaxVisible = stacked
    ? takeoverLayout.listMaxVisible
    : Math.max(3, contentHeight - 2)
  // Viewport height for the scrollable body. Stacked-inline there is no pane
  // border to carry the file name and scroll position, so a header row does —
  // and that row comes out of the body's budget.
  const bodyHeight = split
    ? contentHeight
    : stacked
      ? takeoverLayout.diffInner
      : Math.max(3, contentHeight - 1)

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
        // Two columns are reserved for the cursor/selection gutter DiffPane
        // prefixes, so wrapping has to happen two columns earlier.
        width: Math.max(10, diffWidth - DIFF_GUTTER_WIDTH),
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

  // ── diff cursor + visual selection ────────────────────────────────────────
  // The cursor indexes RENDERED rows (a wrapped source line spans several), and
  // rowLineIndex maps those back to new-file line numbers for the @mention.
  // null means the renderer and the segments disagreed — selection is then
  // disabled for this file rather than attaching a range built on a guess.
  const cursorRowClamped = Math.max(
    0,
    Math.min(cursorRow, Math.max(0, diffRows.length - 1)),
  )
  const rowLineIndex = useMemo(
    () => buildRowLineIndex(segments, diffRows),
    [segments, diffRows],
  )
  const canSelectLines = rowLineIndex !== null && sidePanel !== null
  const visualRange =
    visualAnchor === null
      ? null
      : {
          from: Math.min(visualAnchor, cursorRowClamped),
          to: Math.max(visualAnchor, cursorRowClamped),
        }

  /** Move the cursor by `delta` rows, scrolling the viewport to keep it in view. */
  const moveCursor = (delta: number): void => {
    const next = Math.max(
      0,
      Math.min(diffRows.length - 1, cursorRowClamped + delta),
    )
    setCursorRow(next)
    if (next < diffScrollClamped) setDiffScroll(next)
    else if (next >= diffScrollClamped + bodyHeight) {
      setDiffScroll(Math.max(0, next - bodyHeight + 1))
    }
  }

  /**
   * Turn a line range into an `@path#La-Lb` mention at the prompt cursor and
   * hand the keyboard back. The mention path is the one the agent's own
   * @-mention parser reads, so nothing new has to reach the message pipeline.
   * Shared by the keyboard (`v` + Enter) and the mouse path, so they cannot
   * produce different text for the same lines.
   */
  const attachRange = (range: { start: number; end: number }): void => {
    if (!selected || !sidePanel) return
    const path = relative(getCwd(), resolve(selected.root || getCwd(), selected.file.path))
    const suffix =
      range.start === range.end ? `#L${range.start}` : `#L${range.start}-${range.end}`
    sidePanel.insertText(`@${path}${suffix}`)
    sidePanel.setFocus('prompt')
  }

  const confirmSelection = (): void => {
    const range =
      rowLineIndex && visualRange
        ? selectionRange(rowLineIndex, visualRange.from, visualRange.to)
        : null
    setVisualAnchor(null)
    if (range) attachRange(range)
  }

  // A finished mouse drag over the diff attaches its lines the same way — the
  // move people reach for first, and before this it only copied.
  const diffPaneRef = useRef<DOMElement | null>(null)
  useDiffSelectionMention({
    enabled: stacked && sidePanel !== null && selected !== null,
    paneRef: diffPaneRef,
    rowLineIndex,
    scrollOffset: diffScrollClamped,
    height: bodyHeight,
    onRange: range => {
      // Drop any open `v` selection so two highlights never compete.
      setVisualAnchor(null)
      attachRange(range)
    },
  })

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

  // Reset reveal, scroll, cursor and any open selection when the file changes.
  const selectedKey = `${sourceIndex}:${selected?.file.path ?? ''}`
  useEffect(() => {
    setRevealed(new Map())
    setExpandAll(false)
    setDiffScroll(0)
    setCursorRow(0)
    setVisualAnchor(null)
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
  // The file list is a SELECTION (like the Local tab's), not just a scroll
  // offset — Enter/→ on the highlighted row opens that file's diff.
  const logFileIndexClamped = Math.min(
    logFileIndex,
    Math.max(0, commitFileCount - 1),
  )
  const logSelectedFile = commitFiles?.[logFileIndexClamped] ?? null
  const logFilesLabel =
    commitFileCount > 0 ? `${logFileIndexClamped + 1}/${commitFileCount}` : ''
  // Land back on the first file — and close any open diff — when the commit
  // changes.
  useEffect(() => {
    setLogFileIndex(0)
    setLogDiffOpen(false)
  }, [selectedHash])

  // Level 3: the selected file's diff within that commit. `git show -p` runs
  // only once the user drills in, so moving through the log stays one
  // `--numstat` call per commit.
  const commitHunks = useCommitDiff(selectedHash, logRoot, logDiffOpen)
  const logHunks = useMemo<StructuredPatchHunk[]>(
    () => (logSelectedFile ? (commitHunks?.get(logSelectedFile.path) ?? []) : []),
    [commitHunks, logSelectedFile],
  )
  // No working-tree text exists for a historical commit, so gap collapsing is
  // off (undefined content) and the hunks render verbatim, like `git show`.
  const logDiffRows = useMemo(
    () =>
      renderDiffRows(buildDiffRenderModel(logHunks, undefined), {
        filePath: logSelectedFile?.path ?? '',
        firstLine: null,
        width: diffWidth,
        theme,
      }),
    [logHunks, logSelectedFile, diffWidth, theme],
  )
  const maxLogDiffScroll = Math.max(0, logDiffRows.length - bodyHeight)
  const logDiffScrollClamped = Math.min(logDiffScroll, maxLogDiffScroll)
  const logDiffScrollLabel =
    maxLogDiffScroll > 0
      ? `${logDiffScrollClamped + 1}-${Math.min(
          logDiffRows.length,
          logDiffScrollClamped + bodyHeight,
        )}/${logDiffRows.length}`
      : ''
  // Back to the top of the diff whenever a different file (or commit) is shown.
  useEffect(() => {
    setLogDiffScroll(0)
  }, [selectedHash, logSelectedFile?.path])

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

  /** Move the Log file selection by `delta`, clamped to the commit's files. */
  const moveLogFile = (delta: number): void =>
    setLogFileIndex(i => {
      const last = Math.max(0, commitFileCount - 1)
      return Math.max(0, Math.min(last, Math.min(i, last) + delta))
    })

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
    setLogDiffScroll(0)
  }

  const handleCancel = (): void => {
    // Esc peels one layer at a time; an active selection is the innermost.
    if (visualAnchor !== null) {
      setVisualAnchor(null)
      return
    }
    if (activeTab === 'log' && logDiffOpen) setLogDiffOpen(false)
    else if (focus === 'content') setFocus('list')
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
        // Log tab: step back one level at a time (diff → files → commits).
        if (activeTab === 'log' && logDiffOpen) {
          setLogDiffOpen(false)
          return
        }
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
      // ctrl+↑ / ctrl+↓ : move between the stacked sections and nothing else.
      // Deliberately NOT aliases of diff:focusList/focusContent — those also
      // collapse and expand a folder row, which is not what a focus key should
      // do. Returning false when there is nowhere to go leaves the key free.
      'diff:focusSectionUp': () => {
        if (focus !== 'content') return false
        setFocus('list')
      },
      'diff:focusSectionDown': () => {
        if (focus !== 'list') return false
        setFocus('content')
      },
      // → : file list → Diff/content pane; on a collapsed folder/group, expand it.
      'diff:focusContent': () => {
        // Log tab, files pane focused: → drills into the selected file's diff.
        if (activeTab === 'log' && focus === 'content') {
          if (logDiffOpen || !logSelectedFile) return false
          setLogDiffOpen(true)
          return
        }
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
          // Content focused on Local: ↑ moves the cursor line (and extends the
          // selection when one is open); the viewport follows it. The body is
          // windowed over pre-rendered rows and needs no alt-screen viewport.
          if (activeTab === 'local') {
            moveCursor(-1)
            return
          }
          if (logDiffOpen) {
            setLogDiffScroll(s => Math.max(0, s - 1))
            return
          }
          moveLogFile(-1)
          return
        }
        if (activeTab === 'local') setSelectedIndex(i => Math.max(0, i - 1))
        else setLogSelectedRow(r => adjacentCommitRow(gitLog.rows, r, -1))
      },
      'diff:nextFile': () => {
        if (focus === 'content') {
          if (activeTab === 'local') {
            moveCursor(1)
            return
          }
          if (logDiffOpen) {
            setLogDiffScroll(s => Math.min(maxLogDiffScroll, s + 1))
            return
          }
          moveLogFile(1)
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
          // With a selection open, Enter confirms it instead of growing a gap.
          if (visualAnchor !== null) {
            confirmSelection()
            return
          }
          expandNextGap()
          return
        }
        // Log tab: Enter on a file opens its diff (the third level).
        if (!logDiffOpen && logSelectedFile) {
          setLogDiffOpen(true)
          return
        }
        return false
      },
      'diff:expandAll': () => {
        if (activeTab === 'local') setExpandAll(x => !x)
        else return false
      },
      'diff:refresh': refresh,
      // v: start / clear a visual line selection in the diff pane.
      'diff:select': () => {
        if (activeTab !== 'local' || focus !== 'content') return false
        setVisualAnchor(a => (a === null ? cursorRowClamped : null))
      },
      // ctrl+← steps back out to the prompt. It needs its own action in the
      // DiffDialog context: a `Chat` binding is unreachable from here, since
      // nothing registers `Chat` as an *active* context.
      'diff:focusPrompt': () => {
        if (!sidePanel) return false
        sidePanel.setFocus('prompt')
      },
    },
    { context: 'DiffDialog', isActive: hasFocus },
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
      // Same unit as ↑/↓ here: the cursor moves and the viewport follows, so a
      // selection can be extended a page at a time.
      if (up) moveCursor(-page)
      else if (down) moveCursor(page)
      else if (home) moveCursor(-diffRows.length)
      else moveCursor(diffRows.length)
      return
    }
    if (logDiffOpen) {
      if (up) setLogDiffScroll(s => Math.max(0, s - page))
      else if (down)
        setLogDiffScroll(s => Math.min(maxLogDiffScroll, s + page))
      else if (home) setLogDiffScroll(0)
      else setLogDiffScroll(maxLogDiffScroll)
      return
    }
    if (up) moveLogFile(-page)
    else if (down) moveLogFile(page)
    else if (home) setLogFileIndex(0)
    else setLogFileIndex(Math.max(0, commitFileCount - 1))
  }, { isActive: hasFocus })

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
  // Hints in display order, most useful first — `fitHints` drops from the tail
  // when the row is too narrow, which a half-width side panel always is. The
  // closing key is appended last so it never gets dropped.
  const hintParts: string[] =
    !hasFocus
      ? ['ctrl+→ panel', 'type to chat']
      : visualAnchor !== null
        ? ['↑/↓ extend', 'Enter send to prompt', 'v/Esc cancel']
        : activeTab === 'log'
          ? focus === 'content'
            ? logDiffOpen
              ? ['Tab tabs', '↑/↓ scroll', 'u/d page', 'g/G ends', '← files']
              : ['Tab tabs', '↑/↓ files', 'Enter/→ diff', '← commits', 'u/d page']
            : [
                'Tab tabs',
                '↑/↓ commits',
                '→ files',
                '← back',
                ...(logRepos.length > 1 ? ['[ ] project'] : []),
                'u/d page',
                'r refresh',
              ]
          : focus === 'content'
            ? [
                'Tab tabs',
                '↑/↓ move',
                ...(canSelectLines ? ['v select'] : []),
                ...(canSelectLines ? ['drag to attach'] : []),
                'ctrl+↑ files',
                ...(sidePanel ? ['ctrl+← chat'] : []),
                'Enter expand gap',
                'u/d page',
                'a expand all',
              ]
            : [
                'Tab tabs',
                '↑/↓ move',
                'ctrl+↓ diff',
                ...(canSelectLines ? ['drag to attach'] : []),
                ...(sidePanel ? ['ctrl+← chat'] : []),
                '[ ] source',
                '←/→ folder',
                'u/d page',
                'a expand',
                'r refresh',
              ]
  // One <Text>, not two columns: siblings in a row Box lay out as independent
  // flex items and wrap separately, which interleaved the status and the hints
  // at panel width (ink-tui.md §10). Drop the status when both don't fit.
  const footerWidth = Math.max(20, usableColumns - 2)
  const closeHint = visualAnchor !== null || !hasFocus ? '' : 'Esc close'
  const hints = fitHints(hintParts, footerWidth, closeHint)
  const footerGap = footerWidth - statusText.length - hints.length
  const footer = (
    <Text dimColor wrap="truncate-end">
      {footerGap >= 2 ? `${statusText}${' '.repeat(footerGap)}${hints}` : hints}
    </Text>
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
        cursorRow={hasFocus && focus === 'content' ? cursorRowClamped : null}
        selection={visualRange}
        backgroundSgr={stacked ? panelBackgroundSgr : null}
      />
    )
  }

  /**
   * Border accent for a pane. Both panes go `subtle` when the keyboard is on
   * the prompt side, so the split never shows two focused-looking halves.
   */
  const paneColor = (pane: Focus): 'permission' | 'subtle' =>
    hasFocus && focus === pane ? 'permission' : 'subtle'

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
          width={stacked ? diffWidth : Math.min(usableColumns, INLINE_LIST_WIDTH)}
        />
      )
    const filesTitle = `Files  ${allFiles.length} ${plural(
      allFiles.length,
      'file',
    )} changed`
    // Stats-only synthetic file — the same shape statsBorderText already takes.
    const filesStatsFile: DiffFile = {
      path: '',
      ...allFiles.reduce(
        (acc, f) => ({
          linesAdded: acc.linesAdded + f.linesAdded,
          linesRemoved: acc.linesRemoved + f.linesRemoved,
        }),
        { linesAdded: 0, linesRemoved: 0 },
      ),
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
    }
    // Basename only: the tree right above already shows the directory, so the
    // full path spent a third of the rule repeating it. Stacked layout only —
    // inline shows EITHER the list or the diff, never both, so the path there
    // is the only context there is.
    const diffTitle = selected
      ? `Diff: ${basename(selected.file.path)}${
          selected.file.isTruncated ? ' (truncated)' : ''
        }${diffScrollLabel ? `  ${diffScrollLabel}` : ''}`
      : 'Diff'
    // Untracked files carry no git line counts; show the synthesized all-added
    // count so the new-file diff still reports +N.
    const diffStatsFile: DiffFile | undefined =
      selected && isUntrackedFile && effectiveHunks.length > 0
        ? {
            ...selected.file,
            linesAdded: effectiveHunks[0]!.newLines,
            linesRemoved: 0,
          }
        : selected?.file
    const filesBorderText = (() => {
      const stats = statsBorderText(filesStatsFile)
      return stats ? [paneTitle(filesTitle), stats] : paneTitle(filesTitle)
    })()
    const diffBorderText = (() => {
      const stats = diffStatsFile ? statsBorderText(diffStatsFile) : null
      return stats ? [paneTitle(diffTitle), stats] : paneTitle(diffTitle)
    })()
    // Takeover: the file list sits ON TOP of a full-width diff, both in fixed-
    // height sections so the frame never moves with the selected file's length.
    // Each section is a TOP BORDER ONLY: the rule carries the title and the
    // +N −N the way a pane border used to, but without the vertical edges — so
    // the text gets those two columns back, and the whole frame costs one row
    // per section instead of two.
    body = stacked ? (
      <Box flexDirection="column">
        <Box
          height={takeoverLayout.listInner + 1}
          flexShrink={0}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={paneColor('list')}
          borderText={filesBorderText}
        >
          {listEl}
        </Box>
        <Box
          ref={diffPaneRef}
          height={takeoverLayout.diffInner + 1}
          flexShrink={0}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={paneColor('content')}
          borderText={diffBorderText}
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
        selectedIndex={logFileIndexClamped}
      />
    )
    const commitFilesTitle = selectedHash
      ? `Files in ${selectedHash.slice(0, 7)}`
      : 'Files'
    // Level 3: the selected file's diff inside the commit. Same windowed
    // DiffPane the Local tab uses; gaps aren't collapsible here (no file text).
    const commitDiffEl = !logSelectedFile ? (
      <Text dimColor>Select a file to view its diff</Text>
    ) : logSelectedFile.isBinary ? (
      <Text dimColor italic>Binary file - cannot display diff</Text>
    ) : commitHunks === null ? (
      <Text dimColor>Loading diff…</Text>
    ) : logDiffRows.length === 0 && logSelectedFile.renamedFrom ? (
      <Text dimColor italic>
        {`renamed from ${logSelectedFile.renamedFrom}`}
      </Text>
    ) : (
      <DiffPane
        rows={logDiffRows}
        scrollOffset={logDiffScrollClamped}
        height={bodyHeight}
        width={diffWidth}
      />
    )
    const contentEl = logDiffOpen ? commitDiffEl : filesEl
    const contentTitle = logDiffOpen
      ? `Diff: ${logSelectedFile?.path ?? ''}`
      : commitFilesTitle
    const contentLabel = logDiffOpen ? logDiffScrollLabel : logFilesLabel
    body = split ? (
      <Box flexDirection="row" gap={1}>
        <Box
          width={leftWidth}
          flexShrink={0}
          height={paneHeight}
          overflow="hidden"
          flexDirection="column"
          borderStyle="round"
          borderColor={paneColor('list')}
          borderText={paneTitle('Log')}
        >
          {graphEl}
        </Box>
        <Box
          flexGrow={1}
          height={paneHeight}
          overflow="hidden"
          flexDirection="column"
          borderColor={paneColor('content')}
          borderStyle="round"
          borderText={(() => {
            const title = paneTitle(
              `${contentTitle}${contentLabel ? `  ${contentLabel}` : ''}`,
            )
            // Right-aligned totals like the Local diff pane, reusing
            // statsBorderText via a synthetic stats-only file: the selected
            // file's counts while its diff is open, the commit-wide sums
            // otherwise.
            const counts = logDiffOpen
              ? logSelectedFile && {
                  added: logSelectedFile.added,
                  removed: logSelectedFile.removed,
                  binary: logSelectedFile.isBinary,
                }
              : commitStats && {
                  added: commitStats.added,
                  removed: commitStats.removed,
                  binary: false,
                }
            const stats = counts
              ? statsBorderText({
                  path: '',
                  linesAdded: counts.added,
                  linesRemoved: counts.removed,
                  isBinary: counts.binary,
                  isLargeFile: false,
                  isTruncated: false,
                })
              : null
            return stats ? [title, stats] : title
          })()}
        >
          {contentEl}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column" marginTop={1}>
        {focus === 'list' ? (
          graphEl
        ) : (
          <>
            {stackedHeader(contentTitle, contentLabel)}
            {contentEl}
          </>
        )}
      </Box>
    )
  }

  return (
    <Dialog
      title={tabBar}
      onCancel={handleCancel}
      hideInputGuide
      isCancelActive={hasFocus}
    >
      {sourceLine}
      {projectLine}
      {body}
      {footer}
    </Dialog>
  )
}
