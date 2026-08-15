/**
 * Pure, framework-free buffer + cursor + modal-editing engine for the
 * /explorer editor (nvim-lite). No React, no Ink imports — so it stays
 * unit-testable under `bun test` (team memory: anything reaching ../ink.js
 * fails to load under the test runner).
 *
 * Every operation returns a NEW EditorState; strings are immutable so undo
 * snapshots only need a shallow copy of the `lines` array.
 */

export type Mode = 'normal' | 'insert' | 'command'

export type Cursor = { row: number; col: number }

type Snapshot = { lines: string[]; cursor: Cursor }

export type EditorState = {
  lines: string[]
  cursor: Cursor
  /** Preferred column for vertical motion (j/k), so passing a short line keeps it. */
  colDesired: number
  mode: Mode
  /** Current ':' command-line text (mode === 'command'). */
  command: string
  dirty: boolean
  /**
   * An i/a/A/I insert session is open but no edit has happened yet, so the
   * undo snapshot + dirty flag are deferred until the first real change. Keeps
   * a bare `i`<Esc> (or a no-op backspace) from dirtying an untouched buffer.
   */
  pendingInsert: boolean
  /** Linewise yank/delete register. */
  register: string[]
  /** Pending first key of a two-stroke chord ('d' for dd, 'g' for gg, 'y' for yy). */
  pending: string | null
  /** Transient mode-line message ('written', 'No write since last change', …). */
  message: string
  undo: Snapshot[]
  redo: Snapshot[]
}

const UNDO_LIMIT = 200

export function createEditorState(text: string): EditorState {
  return {
    lines: splitLines(text),
    cursor: { row: 0, col: 0 },
    colDesired: 0,
    mode: 'normal',
    command: '',
    dirty: false,
    pendingInsert: false,
    register: [],
    pending: null,
    message: '',
    undo: [],
    redo: [],
  }
}

/** Split file text into editable lines (a trailing newline is NOT a line). */
export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Serialize the buffer back to file text with LF separators. `finalNewline`
 * preserves whether the original file ended with one (no diff-noise — we never
 * add/remove the trailing newline). CRLF re-application is left to
 * writeTextContent(…, endings), which converts every \n when endings === 'CRLF'.
 */
export function serialize(lines: string[], finalNewline: boolean): string {
  return lines.join('\n') + (finalNewline ? '\n' : '')
}

// ── helpers ─────────────────────────────────────────────────────────────────

function clone(s: EditorState): EditorState {
  return { ...s, cursor: { ...s.cursor } }
}

function snapshot(s: EditorState): Snapshot {
  return { lines: s.lines.slice(), cursor: { ...s.cursor } }
}

/** Max cursor column for the current line. INSERT can sit one past the end. */
function maxCol(s: EditorState, mode: Mode = s.mode): number {
  const len = s.lines[s.cursor.row]?.length ?? 0
  return mode === 'insert' ? len : Math.max(0, len - 1)
}

/** Clamp row/col into range after a mutation. */
function clamp(s: EditorState): EditorState {
  const row = Math.min(Math.max(0, s.cursor.row), Math.max(0, s.lines.length - 1))
  s.cursor.row = row
  s.cursor.col = Math.min(Math.max(0, s.cursor.col), maxCol(s))
  return s
}

/** Snapshot for undo, clear redo, mark dirty — call before any buffer mutation. */
function beginChange(s: EditorState): void {
  s.undo = [...s.undo, snapshot(s)].slice(-UNDO_LIMIT)
  s.redo = []
  s.dirty = true
}

/**
 * Take the deferred insert-session snapshot on the first actual edit (see
 * EditorState.pendingInsert). A no-op call once the snapshot is taken, so the
 * whole insert session stays a single undo step.
 */
function snapshotIfPending(s: EditorState): void {
  if (s.pendingInsert) {
    beginChange(s)
    s.pendingInsert = false
  }
}

// ── motions ─────────────────────────────────────────────────────────────────

export function moveLeft(state: EditorState): EditorState {
  const s = clone(state)
  s.cursor.col = Math.max(0, s.cursor.col - 1)
  s.colDesired = s.cursor.col
  return s
}

export function moveRight(state: EditorState): EditorState {
  const s = clone(state)
  s.cursor.col = Math.min(maxCol(s), s.cursor.col + 1)
  s.colDesired = s.cursor.col
  return s
}

export function moveUp(state: EditorState): EditorState {
  const s = clone(state)
  if (s.cursor.row > 0) {
    s.cursor.row--
    s.cursor.col = Math.min(s.colDesired, maxCol(s))
  }
  return s
}

export function moveDown(state: EditorState): EditorState {
  const s = clone(state)
  if (s.cursor.row < s.lines.length - 1) {
    s.cursor.row++
    s.cursor.col = Math.min(s.colDesired, maxCol(s))
  }
  return s
}

export function moveLineStart(state: EditorState): EditorState {
  const s = clone(state)
  s.cursor.col = 0
  s.colDesired = 0
  return s
}

export function moveLineEnd(state: EditorState): EditorState {
  const s = clone(state)
  s.cursor.col = maxCol(s)
  s.colDesired = Number.MAX_SAFE_INTEGER
  return s
}

export function gotoTop(state: EditorState): EditorState {
  const s = clone(state)
  s.cursor.row = 0
  s.cursor.col = Math.min(s.colDesired, maxCol(s))
  return s
}

export function gotoBottom(state: EditorState): EditorState {
  const s = clone(state)
  s.cursor.row = Math.max(0, s.lines.length - 1)
  s.cursor.col = Math.min(s.colDesired, maxCol(s))
  return s
}

/**
 * Move the cursor `delta` rows (PgUp/PgDn, ctrl+d/ctrl+u). The view follows
 * the cursor, so this is what scrolls the pane; clamps at both ends.
 */
export function movePage(state: EditorState, delta: number): EditorState {
  return gotoLine(state, state.cursor.row + 1 + delta)
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

export function wordForward(state: EditorState): EditorState {
  const s = clone(state)
  const line = s.lines[s.cursor.row] ?? ''
  let i = s.cursor.col
  // skip the current word, then skip whitespace to the next word start
  while (i < line.length && WORD_CHAR.test(line[i]!)) i++
  while (i < line.length && !WORD_CHAR.test(line[i]!)) i++
  if (i >= line.length && s.cursor.row < s.lines.length - 1) {
    s.cursor.row++
    s.cursor.col = 0
  } else {
    s.cursor.col = Math.min(i, maxCol(s))
  }
  s.colDesired = s.cursor.col
  return s
}

export function wordBackward(state: EditorState): EditorState {
  const s = clone(state)
  const line = s.lines[s.cursor.row] ?? ''
  let i = s.cursor.col - 1
  while (i > 0 && !WORD_CHAR.test(line[i]!)) i--
  while (i > 0 && WORD_CHAR.test(line[i - 1]!)) i--
  if (i < 0) i = 0
  s.cursor.col = i
  s.colDesired = i
  return s
}

// ── insert mode ──────────────────────────────────────────────────────────────

export function enterInsert(
  state: EditorState,
  variant: 'i' | 'a' | 'A' | 'I' = 'i',
): EditorState {
  const s = clone(state)
  // Defer the undo snapshot until the first edit (snapshotIfPending), so a bare
  // i/a/A/I followed by <Esc> with no typing leaves the buffer unchanged.
  s.pendingInsert = true
  s.mode = 'insert'
  if (variant === 'a') s.cursor.col = Math.min(s.cursor.col + 1, maxCol(s, 'insert'))
  else if (variant === 'A') s.cursor.col = maxCol(s, 'insert')
  else if (variant === 'I') s.cursor.col = 0
  return s
}

export function leaveInsert(state: EditorState): EditorState {
  const s = clone(state)
  s.mode = 'normal'
  s.pendingInsert = false
  // nvim pulls the cursor back one column when leaving insert
  s.cursor.col = Math.min(s.cursor.col, maxCol(s, 'normal'))
  s.colDesired = s.cursor.col
  return s
}

export function insertText(state: EditorState, text: string): EditorState {
  const s = clone(state)
  snapshotIfPending(s)
  const line = s.lines[s.cursor.row] ?? ''
  const col = Math.min(s.cursor.col, line.length)
  s.lines = s.lines.slice()
  s.lines[s.cursor.row] = line.slice(0, col) + text + line.slice(col)
  s.cursor.col = col + text.length
  s.colDesired = s.cursor.col
  s.dirty = true
  return s
}

export function insertNewline(state: EditorState): EditorState {
  const s = clone(state)
  snapshotIfPending(s)
  const line = s.lines[s.cursor.row] ?? ''
  const col = Math.min(s.cursor.col, line.length)
  s.lines = s.lines.slice()
  s.lines.splice(s.cursor.row, 1, line.slice(0, col), line.slice(col))
  s.cursor.row++
  s.cursor.col = 0
  s.colDesired = 0
  s.dirty = true
  return s
}

export function backspace(state: EditorState): EditorState {
  const s = clone(state)
  // Backspace at the very start of the buffer is a no-op — don't snapshot or
  // dirty (matches deleteCharUnderCursor's empty-line guard).
  if (s.cursor.col === 0 && s.cursor.row === 0) return s
  snapshotIfPending(s)
  s.lines = s.lines.slice()
  if (s.cursor.col > 0) {
    const line = s.lines[s.cursor.row] ?? ''
    s.lines[s.cursor.row] = line.slice(0, s.cursor.col - 1) + line.slice(s.cursor.col)
    s.cursor.col--
  } else if (s.cursor.row > 0) {
    const prev = s.lines[s.cursor.row - 1] ?? ''
    const cur = s.lines[s.cursor.row] ?? ''
    s.cursor.col = prev.length
    s.lines.splice(s.cursor.row - 1, 2, prev + cur)
    s.cursor.row--
  }
  s.colDesired = s.cursor.col
  s.dirty = true
  return s
}

// ── normal-mode edits ────────────────────────────────────────────────────────

export function deleteCharUnderCursor(state: EditorState): EditorState {
  const s = clone(state)
  const line = s.lines[s.cursor.row] ?? ''
  if (line.length === 0) return s
  beginChange(s)
  s.lines = s.lines.slice()
  s.lines[s.cursor.row] = line.slice(0, s.cursor.col) + line.slice(s.cursor.col + 1)
  return clamp(s)
}

export function deleteLine(state: EditorState): EditorState {
  const s = clone(state)
  beginChange(s)
  s.register = [s.lines[s.cursor.row] ?? '']
  s.lines = s.lines.slice()
  s.lines.splice(s.cursor.row, 1)
  if (s.lines.length === 0) s.lines = ['']
  s.cursor.col = 0
  s.colDesired = 0
  return clamp(s)
}

export function yankLine(state: EditorState): EditorState {
  const s = clone(state)
  s.register = [s.lines[s.cursor.row] ?? '']
  s.message = '1 line yanked'
  return s
}

export function pasteAfter(state: EditorState): EditorState {
  if (state.register.length === 0) return state
  const s = clone(state)
  beginChange(s)
  s.lines = s.lines.slice()
  s.lines.splice(s.cursor.row + 1, 0, ...s.register)
  s.cursor.row += 1
  s.cursor.col = 0
  s.colDesired = 0
  return clamp(s)
}

export function pasteBefore(state: EditorState): EditorState {
  if (state.register.length === 0) return state
  const s = clone(state)
  beginChange(s)
  s.lines = s.lines.slice()
  s.lines.splice(s.cursor.row, 0, ...s.register)
  s.cursor.col = 0
  s.colDesired = 0
  return clamp(s)
}

export function openBelow(state: EditorState): EditorState {
  const s = clone(state)
  beginChange(s)
  s.pendingInsert = false // o/O edit on entry, so the snapshot is already taken
  s.lines = s.lines.slice()
  s.lines.splice(s.cursor.row + 1, 0, '')
  s.cursor.row += 1
  s.cursor.col = 0
  s.colDesired = 0
  s.mode = 'insert'
  return s
}

export function openAbove(state: EditorState): EditorState {
  const s = clone(state)
  beginChange(s)
  s.pendingInsert = false // o/O edit on entry, so the snapshot is already taken
  s.lines = s.lines.slice()
  s.lines.splice(s.cursor.row, 0, '')
  s.cursor.col = 0
  s.colDesired = 0
  s.mode = 'insert'
  return s
}

// ── undo / redo ──────────────────────────────────────────────────────────────

export function undo(state: EditorState): EditorState {
  if (state.undo.length === 0) {
    const s = clone(state)
    s.message = 'Already at oldest change'
    return s
  }
  const s = clone(state)
  const snap = s.undo[s.undo.length - 1]!
  s.redo = [...s.redo, snapshot(s)].slice(-UNDO_LIMIT)
  s.undo = s.undo.slice(0, -1)
  s.lines = snap.lines.slice()
  s.cursor = { ...snap.cursor }
  s.dirty = true
  return clamp(s)
}

export function redo(state: EditorState): EditorState {
  if (state.redo.length === 0) {
    const s = clone(state)
    s.message = 'Already at newest change'
    return s
  }
  const s = clone(state)
  const snap = s.redo[s.redo.length - 1]!
  s.undo = [...s.undo, snapshot(s)].slice(-UNDO_LIMIT)
  s.redo = s.redo.slice(0, -1)
  s.lines = snap.lines.slice()
  s.cursor = { ...snap.cursor }
  s.dirty = true
  return clamp(s)
}

// ── ':' command line ─────────────────────────────────────────────────────────

export type ExAction =
  | { kind: 'none' }
  | { kind: 'invalid'; raw: string }
  | { kind: 'write'; force: boolean }
  | { kind: 'quit'; force: boolean }
  | { kind: 'writeQuit'; force: boolean }
  | { kind: 'goto'; line: number }

/** Parse a `:`-command body (without the leading colon) into an action. */
export function parseExCommand(raw: string): ExAction {
  const cmd = raw.trim()
  if (cmd === '') return { kind: 'none' }
  if (/^\d+$/.test(cmd)) return { kind: 'goto', line: parseInt(cmd, 10) }
  switch (cmd) {
    case 'w':
      return { kind: 'write', force: false }
    case 'w!':
      return { kind: 'write', force: true }
    case 'q':
      return { kind: 'quit', force: false }
    case 'q!':
      return { kind: 'quit', force: true }
    case 'wq':
    case 'x':
      return { kind: 'writeQuit', force: false }
    case 'wq!':
      return { kind: 'writeQuit', force: true }
    default:
      return { kind: 'invalid', raw: cmd }
  }
}

export function gotoLine(state: EditorState, line1: number): EditorState {
  const s = clone(state)
  s.cursor.row = Math.min(Math.max(0, line1 - 1), Math.max(0, s.lines.length - 1))
  s.cursor.col = Math.min(s.colDesired, maxCol(s))
  return s
}
