import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { basename, dirname, resolve } from 'path'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import {
  clearFileSuggestionCaches,
  getProjectFilePaths,
} from '../../hooks/fileSuggestions.js'
import type { DiffFile } from '../../hooks/useDiffData.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useWorkspaceDiff } from '../../hooks/useWorkspaceDiff.js'
import { Box, Text, useInput, useTheme } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { TreeRow } from '../diff/fileTree.js'
import { getCwd } from '../../utils/cwd.js'
import { writeFileSyncAndFlush, writeTextContent } from '../../utils/file.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { logError } from '../../utils/log.js'
import { hasNerdFontGlyphs } from '../../utils/terminalFont.js'
import type { Theme } from '../../utils/theme.js'
import { Dialog } from '../design-system/Dialog.js'
import { DiffFileList, INLINE_LIST_WIDTH } from '../diff/DiffFileList.js'
import { expectEditorHighlighter } from '../StructuredDiff/colorDiff.js'
import {
  backspace,
  createEditorState,
  deleteCharUnderCursor,
  deleteLine,
  type EditorState,
  enterInsert,
  gotoBottom,
  gotoLine,
  gotoTop,
  insertNewline,
  insertText,
  leaveInsert,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  openAbove,
  openBelow,
  parseExCommand,
  pasteAfter,
  pasteBefore,
  redo,
  serialize,
  undo,
  wordBackward,
  wordForward,
  yankLine,
} from './editorState.js'
import { createPrefill, resolveNewFilePath } from './explorerActions.js'
import { FilePane } from './FilePane.js'
import { buildFileIndex, FuzzyOverlay } from './fuzzyFinder.js'
import {
  buildChangedRows,
  buildExplorerGroup,
  buildExplorerRows,
  CHANGED_GROUP_KEY,
  collectChangedFiles,
  initialCollapsed,
} from './tree.js'

type Props = {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}

/**
 * Git status → tint for the tree (modified amber, new/untracked green, renamed
 * blue). These must be THEME keys: `colorize` only understands theme values
 * (`ansi:*`, `#hex`, `rgb()`, `ansi256()`), so a bare `'yellow'` silently
 * renders uncolored.
 */
const STATUS_COLORS: Record<string, keyof Theme> = {
  modified: 'warning',
  new: 'success',
  untracked: 'success',
  renamed: 'suggestion',
}

function statusOf(f: DiffFile): string {
  if (f.isUntracked) return 'untracked'
  if (f.isNewFile) return 'new'
  if (f.renamedFrom) return 'renamed'
  return 'modified'
}

type OpenFile = {
  relPath: string
  fullPath: string
  root: string
  encoding: BufferEncoding
  lineEnding: 'LF' | 'CRLF'
  finalNewline: boolean
  firstLine: string | null
  mtimeMs: number
  /** Set when the file can be viewed but not edited (binary / >2MB). */
  notice: string | null
}

const MAX_EDIT_BYTES = 2 * 1024 * 1024

/** Top-aligned border title (mirrors DiffDialog.paneTitle). */
function paneTitle(text: string): {
  content: string
  position: 'top'
  align: 'start'
} {
  return { content: ` ${text} `, position: 'top', align: 'start' }
}

export function ExplorerDialog({ onDone, context }: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [theme] = useTheme()
  useRegisterOverlay('explorer-dialog', true)

  const root = useMemo(() => getCwd(), [])

  // ── layout (mirrors DiffDialog) ───────────────────────────────────────────
  const split = isFullscreenEnvEnabled() && columns >= 100
  const leftWidth = Math.max(30, Math.min(50, Math.round(columns * 0.3)))
  const contentHeight = Math.max(6, rows - 12)
  const paneHeight = contentHeight + 2
  const rightWidth = Math.max(20, columns - leftWidth - 10)
  // Inline (no side pane) the tree stands in for the editor pane, which already
  // uses the same budget — so it gets the same height instead of a fixed 15,
  // which both wasted a tall terminal and overflowed a short one.
  const listMaxVisible = Math.max(3, contentHeight - 2)

  // ── state ─────────────────────────────────────────────────────────────────
  const [paths, setPaths] = useState<string[] | null>(null)
  // The "Changed" group starts collapsed: it is a quick-access accessory, and
  // on a busy repo its files would otherwise push the project tree — the point
  // of the explorer — off the bottom of the list.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set([CHANGED_GROUP_KEY]),
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focus, setFocus] = useState<'tree' | 'editor'>('tree')
  const [open, setOpen] = useState<OpenFile | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [treeMessage, setTreeMessage] = useState('')
  // `/` quick-open overlay state (null when closed).
  const [fuzzy, setFuzzy] = useState<{ query: string; selected: number } | null>(
    null,
  )
  // `a` create / `r` rename path-entry overlay (null when closed). One union so
  // both reuse the same typing handler and right-pane input line.
  const [prompt, setPrompt] = useState<
    | { kind: 'create'; value: string }
    | { kind: 'rename'; from: string; root: string; value: string }
    | null
  >(null)
  // Pending `d` delete confirmation for a file (null when not confirming).
  const [confirmDelete, setConfirmDelete] = useState<{
    relPath: string
    root: string
  } | null>(null)
  // Pending first key of a two-stroke chord (g for gg, d for dd, y for yy).
  const pendingOpRef = useRef<string | null>(null)

  // ── data ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    getProjectFilePaths().then(p => {
      if (!alive) return
      setPaths(p)
      setCollapsed(prev => {
        const next = initialCollapsed(buildExplorerGroup(root, p))
        // Keep the user's "Changed" toggle if they hit it while files loaded.
        if (prev.has(CHANGED_GROUP_KEY)) next.add(CHANGED_GROUP_KEY)
        return next
      })
    })
    return () => {
      alive = false
    }
  }, [root])

  const group = useMemo(
    () => buildExplorerGroup(root, paths ?? []),
    [root, paths],
  )
  const treeRows = useMemo(
    () => buildExplorerRows(group, collapsed),
    [group, collapsed],
  )

  const fileIndex = useMemo(() => buildFileIndex(paths ?? []), [paths])
  const fuzzyResults = useMemo(
    () => (fuzzy ? fileIndex.search(fuzzy.query, 50) : []),
    [fileIndex, fuzzy],
  )

  // Git status for tree tinting + the "Changed" quick-access group at the top.
  const workspace = useWorkspaceDiff(
    useMemo(() => [root], [root]),
    useMemo(() => [root], [root]),
  )
  const changedFiles = useMemo(
    () => collectChangedFiles(root, workspace.groups),
    [workspace.groups, root],
  )
  const statusByPath = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of changedFiles) {
      m.set(e.label, STATUS_COLORS[statusOf(e.file)] ?? 'warning')
    }
    return m
  }, [changedFiles])
  const changedRows = useMemo<TreeRow[]>(
    () => buildChangedRows(changedFiles, collapsed),
    [changedFiles, collapsed],
  )
  const allRows = useMemo(
    () => [...changedRows, ...treeRows],
    [changedRows, treeRows],
  )

  const highlighter = useMemo(() => {
    if (!open || open.notice) return null
    const H = expectEditorHighlighter()
    return H ? new H(open.fullPath, open.firstLine, theme) : null
  }, [open, theme])

  // Clamp selection if the row list shrank (e.g. a collapse).
  useEffect(() => {
    if (selectedIndex > allRows.length - 1) {
      setSelectedIndex(Math.max(0, allRows.length - 1))
    }
  }, [allRows.length, selectedIndex])

  const close = (): void => onDone('Explorer closed', { display: 'system' })

  /** Apply a pure editor transform, preserving the null guard. */
  const apply = (fn: (s: EditorState) => EditorState): void =>
    setEditor(e => (e ? fn(e) : e))

  function toggleDir(key: string): void {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Re-list project files after a create/delete/rename so the tree reflects disk. */
  function refreshFiles(): void {
    clearFileSuggestionCaches()
    getProjectFilePaths()
      .then(setPaths)
      .catch(logError)
  }

  function openFileAt(relPath: string, fileRoot: string): void {
    // Drop any half-typed tree chord (e.g. a lone 'g') so it can't leak into
    // the editor's chord handler and eat the first keystroke after focus moves.
    pendingOpRef.current = null
    const fullPath = resolve(fileRoot, relPath)
    let st
    try {
      st = statSync(fullPath)
    } catch (e) {
      logError(e)
      setTreeMessage(`Cannot open ${relPath}`)
      return
    }
    // Too large to edit: open a read-only stub without loading the whole file.
    if (st.size > MAX_EDIT_BYTES) {
      setOpen({
        relPath,
        fullPath,
        root: fileRoot,
        encoding: 'utf8',
        lineEnding: 'LF',
        finalNewline: true,
        firstLine: null,
        mtimeMs: st.mtimeMs,
        notice: 'File too large to edit (>2MB) — read-only',
      })
      setEditor(createEditorState(''))
      setFocus('editor')
      return
    }
    // readFileSyncWithMetadata normalizes CRLF→LF and detects encoding + EOL in
    // one pass. The buffer stays LF; writeTextContent re-applies CRLF on save,
    // so a CRLF file edited at a line end no longer embeds stray \r (BLOCKER).
    let meta
    try {
      meta = readFileSyncWithMetadata(fullPath)
    } catch (e) {
      logError(e)
      setTreeMessage(`Cannot read ${relPath}`)
      return
    }
    const raw = meta.content
    setOpen({
      relPath,
      fullPath,
      root: fileRoot,
      encoding: meta.encoding,
      lineEnding: meta.lineEndings,
      finalNewline: raw.endsWith('\n'),
      firstLine: raw.split('\n', 1)[0] ?? null,
      mtimeMs: st.mtimeMs,
      notice: raw.includes('\u0000') ? 'Binary file — not editable' : null,
    })
    setEditor(createEditorState(raw))
    setFocus('editor')
  }

  /** Write the buffer to disk. Returns a status message. */
  function save(force: boolean): { ok: boolean; message: string } {
    if (!open || !editor) return { ok: false, message: 'No file' }
    if (open.notice) return { ok: false, message: 'File is read-only' }
    // Conflict guard: refuse if the file changed on disk since we opened it.
    if (!force) {
      try {
        const st = statSync(open.fullPath)
        if (st.mtimeMs !== open.mtimeMs) {
          return {
            ok: false,
            message: 'File changed on disk — :w! to overwrite',
          }
        }
      } catch (e) {
        logError(e)
      }
    }
    const content = serialize(editor.lines, open.finalNewline)
    try {
      writeTextContent(open.fullPath, content, open.encoding, open.lineEnding)
    } catch (e) {
      logError(e)
      return { ok: false, message: 'Write failed' }
    }
    // Keep the agent's view of the file coherent so its next Edit/Write doesn't
    // trip the "modified since read" guard.
    let mtimeMs = open.mtimeMs
    try {
      mtimeMs = statSync(open.fullPath).mtimeMs
      context.readFileState?.set(open.fullPath, {
        content,
        timestamp: mtimeMs,
        offset: undefined,
        limit: undefined,
      })
    } catch (e) {
      logError(e)
    }
    setOpen(o => (o ? { ...o, mtimeMs } : o))
    setEditor(e => (e ? { ...e, dirty: false } : e))
    const n = editor.lines.length
    return { ok: true, message: `"${open.relPath}" ${n}L written` }
  }

  // ── input ───────────────────────────────────────────────────────────────
  function handleTreeKey(input: string, key: KeyState): void {
    if (key.escape || (key.ctrl && input === 'c') || input === 'q') {
      close()
      return
    }
    const row = allRows[selectedIndex]
    if (input === 'g') {
      if (pendingOpRef.current === 'g') {
        pendingOpRef.current = null
        setSelectedIndex(0)
      } else {
        pendingOpRef.current = 'g'
      }
      return
    }
    pendingOpRef.current = null
    if (key.downArrow || input === 'j') {
      setSelectedIndex(i => Math.min(allRows.length - 1, i + 1))
    } else if (key.upArrow || input === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1))
    } else if (input === 'G') {
      setSelectedIndex(Math.max(0, allRows.length - 1))
    } else if (key.rightArrow || input === 'l') {
      if (!row) return
      if (row.kind === 'file') openFileAt(row.file.path, row.root)
      else if (row.collapsed) toggleDir(row.key)
    } else if (key.leftArrow || input === 'h') {
      if (row && row.kind !== 'file' && !row.collapsed) toggleDir(row.key)
    } else if (key.return) {
      if (!row) return
      if (row.kind === 'file') openFileAt(row.file.path, row.root)
      else toggleDir(row.key)
    } else if (input === '/') {
      setFuzzy({ query: '', selected: 0 })
    } else if (input === '@') {
      // Mention the path as seen from the explorer root — a nested repo's file
      // is `inner/site/index.html` here, not the repo-relative `site/index.html`.
      if (row?.kind === 'file') mentionFile(row.label ?? row.file.path)
    } else if (input === 'a') {
      setPrompt({ kind: 'create', value: createPrefill(row, root) })
    } else if (input === 'd') {
      if (row?.kind === 'file')
        setConfirmDelete({ relPath: row.file.path, root: row.root })
      else setTreeMessage('Select a file to delete')
    } else if (input === 'r') {
      if (row?.kind === 'file')
        setPrompt({
          kind: 'rename',
          from: row.file.path,
          root: row.root,
          value: row.file.path,
        })
      else setTreeMessage('Select a file to rename')
    }
  }

  /** Typing handler for the `a` create / `r` rename path overlay. */
  function handlePromptKey(input: string, key: KeyState): void {
    if (!prompt) return
    if (key.escape) {
      setPrompt(null)
      return
    }
    if (key.return) {
      const res = resolveNewFilePath(root, prompt.value)
      if (!res.ok) {
        setTreeMessage(res.message)
        setPrompt(null)
        return
      }
      if (prompt.kind === 'create') {
        const exists = existsSync(res.fullPath)
        setPrompt(null)
        if (!exists) {
          try {
            mkdirSync(dirname(res.fullPath), { recursive: true })
            writeFileSyncAndFlush(res.fullPath, '', { encoding: 'utf8' })
            refreshFiles()
          } catch (e) {
            logError(e)
            setTreeMessage(`Cannot create ${res.relPath}`)
            return
          }
        }
        openFileAt(res.relPath, root)
        // A brand-new empty file opens ready to type; an existing one stays in
        // normal mode like any other open.
        if (!exists) setEditor(e => (e ? enterInsert(e, 'i') : e))
        return
      }
      // rename
      const oldFull = resolve(prompt.root, prompt.from)
      if (res.fullPath !== oldFull && existsSync(res.fullPath)) {
        setTreeMessage(`Target exists: ${res.relPath}`)
        setPrompt(null)
        return
      }
      const wasOpen = open?.fullPath === oldFull
      setPrompt(null)
      try {
        mkdirSync(dirname(res.fullPath), { recursive: true })
        renameSync(oldFull, res.fullPath)
        context.readFileState?.delete(oldFull)
        refreshFiles()
        setTreeMessage(`Renamed → ${res.relPath}`)
      } catch (e) {
        logError(e)
        setTreeMessage(`Cannot rename ${prompt.from}`)
        return
      }
      // Reopen under the new path so the editor's view stays coherent.
      if (wasOpen) openFileAt(res.relPath, root)
      return
    }
    if (key.backspace || key.delete) {
      setPrompt(p => (p ? { ...p, value: p.value.slice(0, -1) } : p))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setPrompt(p => (p ? { ...p, value: p.value + input } : p))
    }
  }

  /** Confirm (`y`/`Y`) or cancel (any other key) a pending file delete. */
  function handleConfirmDeleteKey(input: string): void {
    if (!confirmDelete) return
    if (input !== 'y' && input !== 'Y') {
      setConfirmDelete(null)
      return
    }
    const { relPath, root: fileRoot } = confirmDelete
    const fullPath = resolve(fileRoot, relPath)
    setConfirmDelete(null)
    try {
      unlinkSync(fullPath)
      context.readFileState?.delete(fullPath)
      refreshFiles()
      setTreeMessage(`Deleted ${relPath}`)
      if (open?.fullPath === fullPath) backToTree()
    } catch (e) {
      logError(e)
      setTreeMessage(`Cannot delete ${relPath}`)
    }
  }

  function mentionFile(relPath: string): void {
    onDone(undefined, { nextInput: `@${relPath} ` })
  }

  function handleEditorKey(input: string, key: KeyState): void {
    if (!editor) return
    if (key.ctrl && input === 'c') {
      close()
      return
    }
    if (editor.mode === 'command') {
      if (key.escape) {
        setEditor(e => (e ? { ...e, mode: 'normal', command: '' } : e))
      } else if (key.return) {
        runExCommand(editor.command)
      } else if (key.backspace || key.delete) {
        setEditor(e => {
          if (!e) return e
          const cmd = e.command.slice(0, -1)
          return { ...e, command: cmd, mode: cmd === '' ? 'normal' : 'command' }
        })
      } else if (input && !key.ctrl && !key.meta) {
        setEditor(e => (e ? { ...e, command: e.command + input } : e))
      }
      return
    }
    if (editor.mode === 'insert') {
      if (key.escape) apply(leaveInsert)
      else if (key.return) apply(insertNewline)
      else if (key.backspace || key.delete) apply(backspace)
      else if (input && !key.ctrl && !key.meta) apply(e => insertText(e, input))
      return
    }
    // ── NORMAL ──
    const editable = !open?.notice
    if (pendingOpRef.current) {
      const op = pendingOpRef.current
      pendingOpRef.current = null
      if (op === 'd' && input === 'd') {
        if (editable) apply(deleteLine)
      } else if (op === 'y' && input === 'y') apply(yankLine)
      else if (op === 'g' && input === 'g') apply(gotoTop)
      return
    }
    if (key.escape) {
      setFocus('tree')
      return
    }
    if (key.ctrl && input === 'r') {
      if (editable) apply(redo)
      return
    }
    switch (input) {
      case 'd':
      case 'y':
      case 'g':
        pendingOpRef.current = input
        return
      case 'i':
      case 'a':
      case 'A':
      case 'I':
        if (editable) apply(e => enterInsert(e, input))
        return
      case 'o':
        if (editable) apply(openBelow)
        return
      case 'O':
        if (editable) apply(openAbove)
        return
      case 'x':
        if (editable) apply(deleteCharUnderCursor)
        return
      case 'p':
        if (editable) apply(pasteAfter)
        return
      case 'P':
        if (editable) apply(pasteBefore)
        return
      case 'u':
        if (editable) apply(undo)
        return
      case 'h':
        apply(moveLeft)
        return
      case 'l':
        apply(moveRight)
        return
      case 'j':
        apply(moveDown)
        return
      case 'k':
        apply(moveUp)
        return
      case 'w':
        apply(wordForward)
        return
      case 'b':
        apply(wordBackward)
        return
      case '0':
        apply(moveLineStart)
        return
      case '$':
        apply(moveLineEnd)
        return
      case 'G':
        apply(gotoBottom)
        return
      case ':':
        setEditor(e => (e ? { ...e, mode: 'command', command: '', message: '' } : e))
        return
      case '/':
        setFuzzy({ query: '', selected: 0 })
        return
      case '@':
        if (open) mentionFile(open.relPath)
        return
    }
    if (key.leftArrow) apply(moveLeft)
    else if (key.rightArrow) apply(moveRight)
    else if (key.downArrow) apply(moveDown)
    else if (key.upArrow) apply(moveUp)
  }

  function runExCommand(raw: string): void {
    const action = parseExCommand(raw)
    if (action.kind === 'none') {
      setEditor(e => (e ? { ...e, mode: 'normal', command: '' } : e))
      return
    }
    if (action.kind === 'invalid') {
      setEditor(e =>
        e
          ? { ...e, mode: 'normal', command: '', message: `Not a command: :${action.raw}` }
          : e,
      )
      return
    }
    if (action.kind === 'goto') {
      setEditor(e => (e ? { ...gotoLine(e, action.line), mode: 'normal', command: '' } : e))
      return
    }
    const wantsWrite = action.kind === 'write' || action.kind === 'writeQuit'
    const wantsQuit = action.kind === 'quit' || action.kind === 'writeQuit'
    if (wantsWrite) {
      const res = save(action.force)
      if (!res.ok) {
        setEditor(e => (e ? { ...e, mode: 'normal', command: '', message: res.message } : e))
        return
      }
      if (wantsQuit) {
        backToTree()
        return
      }
      setEditor(e => (e ? { ...e, mode: 'normal', command: '', message: res.message } : e))
      return
    }
    // quit
    if (editor?.dirty && !action.force) {
      setEditor(e =>
        e ? { ...e, mode: 'normal', command: '', message: 'No write since last change (:q! to discard)' } : e,
      )
      return
    }
    backToTree()
  }

  function backToTree(): void {
    setOpen(null)
    setEditor(null)
    setFocus('tree')
  }

  function handleFuzzyKey(input: string, key: KeyState): void {
    if (key.escape) {
      setFuzzy(null)
      return
    }
    if (key.return) {
      const r = fuzzyResults[fuzzy?.selected ?? 0]
      setFuzzy(null)
      if (r) openFileAt(r.path, root)
      return
    }
    if (key.upArrow) {
      setFuzzy(f => (f ? { ...f, selected: Math.max(0, f.selected - 1) } : f))
    } else if (key.downArrow) {
      setFuzzy(f =>
        f ? { ...f, selected: Math.min(fuzzyResults.length - 1, f.selected + 1) } : f,
      )
    } else if (key.backspace || key.delete) {
      setFuzzy(f => (f ? { ...f, query: f.query.slice(0, -1), selected: 0 } : f))
    } else if (input && !key.ctrl && !key.meta) {
      setFuzzy(f => (f ? { ...f, query: f.query + input, selected: 0 } : f))
    }
  }

  useInput((input, key) => {
    const k = key as KeyState
    if (prompt) handlePromptKey(input, k)
    else if (confirmDelete) handleConfirmDeleteKey(input)
    else if (fuzzy) handleFuzzyKey(input, k)
    else if (focus === 'tree') handleTreeKey(input, k)
    else handleEditorKey(input, k)
  })

  // ── render ──────────────────────────────────────────────────────────────
  const projectLine = (
    <Text dimColor>{`  ${basename(root)}  ${paths ? `${paths.length} files` : 'loading…'}`}</Text>
  )

  const treePane =
    paths === null ? (
      <Text dimColor>Loading project files…</Text>
    ) : allRows.length === 0 ? (
      <Text dimColor>No files</Text>
    ) : (
      <DiffFileList
        rows={allRows}
        selectedIndex={selectedIndex}
        maxVisible={listMaxVisible}
        width={split ? leftWidth - 2 : Math.min(columns - 4, INLINE_LIST_WIDTH)}
        statusByPath={statusByPath}
        alignFiles
      />
    )

  const editorPane =
    open && editor ? (
      <FilePane
        highlighter={highlighter}
        lines={editor.lines}
        cursor={editor.cursor}
        focused={focus === 'editor'}
        height={contentHeight}
        width={rightWidth}
        readOnlyNotice={open.notice}
      />
    ) : (
      <Text dimColor>Select a file and press Enter to open it.</Text>
    )

  const modeLine = (() => {
    if (confirmDelete) return `Delete "${confirmDelete.relPath}"? (y/n)`
    if (prompt?.kind === 'create') return 'type name · enter create · esc cancel'
    if (prompt?.kind === 'rename') return 'new name · enter rename · esc cancel'
    if (fuzzy) return 'type to find · ↑/↓ select · enter open · esc cancel'
    if (editor?.mode === 'command') return `:${editor.command}`
    if (editor?.mode === 'insert') return '-- INSERT --'
    if (editor?.message) return editor.message
    if (treeMessage) return treeMessage
    if (focus === 'editor')
      return 'NORMAL · i insert · / find · @ chat · :w save · :q quit · esc tree'
    return 'j/k move · l/enter open · a new · d del · r ren · / find · @ chat · q close'
  })()

  const editorTitle = open
    ? `${open.relPath}${editor?.dirty ? ' [+]' : ''}  ${(editor?.cursor.row ?? 0) + 1}:${(editor?.cursor.col ?? 0) + 1}`
    : 'Editor'

  const promptOverlay = prompt ? (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{`${prompt.kind === 'create' ? 'new' : 'rename'} ❯ `}</Text>
        {prompt.value}
        <Text dimColor>▏</Text>
      </Text>
    </Box>
  ) : null

  const rightContent = promptOverlay ? (
    promptOverlay
  ) : fuzzy ? (
    <FuzzyOverlay
      query={fuzzy.query}
      results={fuzzyResults}
      selected={fuzzy.selected}
      width={rightWidth}
      maxVisible={contentHeight}
    />
  ) : (
    editorPane
  )
  const rightTitle = prompt
    ? prompt.kind === 'create'
      ? 'New file'
      : 'Rename'
    : fuzzy
      ? 'Find file'
      : editorTitle

  // Indent the "Files" header to line up with the entry name column
  // (lead 2 + caret 2 + icon 2 when Nerd glyphs render).
  const filesTitle = {
    content: `${' '.repeat(4 + (hasNerdFontGlyphs() ? 2 : 0))}Files `,
    position: 'top' as const,
    align: 'start' as const,
  }

  const body = split ? (
    <Box flexDirection="row" gap={1}>
      <Box
        width={leftWidth}
        flexShrink={0}
        height={paneHeight}
        overflow="hidden"
        flexDirection="column"
        borderStyle="round"
        borderColor={focus === 'tree' ? 'permission' : 'subtle'}
        borderText={filesTitle}
      >
        {treePane}
      </Box>
      <Box
        flexGrow={1}
        height={paneHeight}
        overflow="hidden"
        flexDirection="column"
        borderStyle="round"
        borderColor={
          prompt || fuzzy || focus === 'editor' ? 'permission' : 'subtle'
        }
        borderText={paneTitle(rightTitle)}
      >
        {rightContent}
      </Box>
    </Box>
  ) : (
    <Box flexDirection="column" marginTop={1}>
      {prompt || fuzzy
        ? rightContent
        : focus === 'tree'
          ? treePane
          : editorPane}
    </Box>
  )

  return (
    <Dialog
      title={<Text bold>Explorer</Text>}
      onCancel={close}
      color="background"
      hideInputGuide
      isCancelActive={false}
    >
      {projectLine}
      {body}
      <Text dimColor italic>
        {modeLine}
      </Text>
    </Dialog>
  )
}

/** Minimal Ink key shape (avoids importing ink's Key type across the boundary). */
type KeyState = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  return: boolean
  escape: boolean
  backspace: boolean
  delete: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  tab: boolean
  pageUp: boolean
  pageDown: boolean
}
