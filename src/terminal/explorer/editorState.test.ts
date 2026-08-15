import { describe, expect, test } from 'bun:test'
import {
  backspace,
  createEditorState,
  deleteCharUnderCursor,
  deleteLine,
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
  splitLines,
  undo,
  wordBackward,
  wordForward,
  yankLine,
} from 'src/terminal/explorer/editorState.js'

const text = 'alpha\nbravo\ncharlie'

describe('splitLines / serialize', () => {
  test('a trailing newline is not a line, and round-trips', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(serialize(['a', 'b'], true)).toBe('a\nb\n')
    expect(serialize(['a', 'b'], false)).toBe('a\nb')
  })

  test('empty file is a single empty line', () => {
    expect(splitLines('')).toEqual([''])
  })
})

describe('motions', () => {
  test('moveRight/Left clamp at line bounds (NORMAL stops at last char)', () => {
    let s = createEditorState(text)
    for (let i = 0; i < 10; i++) s = moveRight(s)
    expect(s.cursor.col).toBe(4) // 'alpha' len 5 → last index 4 in NORMAL
    for (let i = 0; i < 10; i++) s = moveLeft(s)
    expect(s.cursor.col).toBe(0)
  })

  test('moveDown keeps desired column when passing a short line', () => {
    let s = createEditorState('longline\nhi\nlongline')
    s = moveLineEnd(s) // col → 7, desired large
    s = moveDown(s) // 'hi' len 2 → clamped to 1
    expect(s.cursor).toEqual({ row: 1, col: 1 })
    s = moveDown(s) // back to a long line → restores desired
    expect(s.cursor.row).toBe(2)
    expect(s.cursor.col).toBe(7)
  })

  test('gotoTop / gotoBottom', () => {
    let s = createEditorState(text)
    s = gotoBottom(s)
    expect(s.cursor.row).toBe(2)
    s = gotoTop(s)
    expect(s.cursor.row).toBe(0)
  })

  test('moveLineStart/End', () => {
    let s = createEditorState(text)
    s = moveLineEnd(s)
    expect(s.cursor.col).toBe(4)
    s = moveLineStart(s)
    expect(s.cursor.col).toBe(0)
  })

  test('wordForward / wordBackward', () => {
    let s = createEditorState('foo bar baz')
    s = wordForward(s)
    expect(s.cursor.col).toBe(4) // start of 'bar'
    s = wordForward(s)
    expect(s.cursor.col).toBe(8) // start of 'baz'
    s = wordBackward(s)
    expect(s.cursor.col).toBe(4)
    s = wordBackward(s)
    expect(s.cursor.col).toBe(0)
  })
})

describe('insert mode', () => {
  test('insertText advances the cursor and marks dirty', () => {
    let s = createEditorState('ac')
    s = enterInsert(s, 'a') // cursor 0 → after 'a' (col 1)
    expect(s.mode).toBe('insert')
    expect(s.cursor.col).toBe(1)
    s = insertText(s, 'b')
    expect(s.lines[0]).toBe('abc')
    expect(s.cursor.col).toBe(2)
    expect(s.dirty).toBe(true)
  })

  test('insertNewline splits the line', () => {
    let s = createEditorState('hello')
    s.cursor.col = 2
    s = insertNewline(s)
    expect(s.lines).toEqual(['he', 'llo'])
    expect(s.cursor).toEqual({ row: 1, col: 0 })
  })

  test('backspace joins lines at column 0', () => {
    let s = createEditorState('ab\ncd')
    s.cursor = { row: 1, col: 0 }
    s = backspace(s)
    expect(s.lines).toEqual(['abcd'])
    expect(s.cursor).toEqual({ row: 0, col: 2 })
  })

  test('leaveInsert pulls the cursor back one column (nvim)', () => {
    let s = createEditorState('abc')
    s = enterInsert(s, 'A') // col → 3 (end, insert can sit past last)
    expect(s.cursor.col).toBe(3)
    s = leaveInsert(s)
    expect(s.mode).toBe('normal')
    expect(s.cursor.col).toBe(2)
  })
})

describe('normal-mode edits + register', () => {
  test('x deletes the char under the cursor', () => {
    let s = createEditorState('abc')
    s = deleteCharUnderCursor(s)
    expect(s.lines[0]).toBe('bc')
  })

  test('dd cuts a line into the register; p pastes it below', () => {
    let s = createEditorState(text)
    s = moveDown(s) // row 1 = 'bravo'
    s = deleteLine(s)
    expect(s.lines).toEqual(['alpha', 'charlie'])
    expect(s.register).toEqual(['bravo'])
    expect(s.cursor.row).toBe(1)
    s = pasteAfter(s) // paste 'bravo' after 'charlie'
    expect(s.lines).toEqual(['alpha', 'charlie', 'bravo'])
    expect(s.cursor.row).toBe(2)
  })

  test('yy copies without mutating; P pastes above', () => {
    let s = createEditorState(text)
    s = yankLine(s)
    expect(s.lines).toEqual(['alpha', 'bravo', 'charlie']) // unchanged
    expect(s.register).toEqual(['alpha'])
    s = moveDown(s)
    s = pasteBefore(s)
    expect(s.lines).toEqual(['alpha', 'alpha', 'bravo', 'charlie'])
  })

  test('deleting the only line leaves one empty line', () => {
    let s = createEditorState('solo')
    s = deleteLine(s)
    expect(s.lines).toEqual([''])
    expect(s.cursor).toEqual({ row: 0, col: 0 })
  })

  test('o/O open a line and enter insert', () => {
    let s = createEditorState('a\nb')
    s = openBelow(s)
    expect(s.lines).toEqual(['a', '', 'b'])
    expect(s.cursor).toEqual({ row: 1, col: 0 })
    expect(s.mode).toBe('insert')
    let t = openAbove(createEditorState('a\nb'))
    expect(t.lines).toEqual(['', 'a', 'b'])
    expect(t.cursor.row).toBe(0)
  })
})

describe('undo / redo', () => {
  test('undo restores the pre-edit buffer; redo reapplies', () => {
    const original = createEditorState(text)
    let s = deleteLine(original)
    expect(s.lines).toEqual(['bravo', 'charlie'])
    s = undo(s)
    expect(s.lines).toEqual(['alpha', 'bravo', 'charlie'])
    s = redo(s)
    expect(s.lines).toEqual(['bravo', 'charlie'])
  })

  test('undo at the oldest change is a no-op with a message', () => {
    const s = undo(createEditorState(text))
    expect(s.lines).toEqual(['alpha', 'bravo', 'charlie'])
    expect(s.message).toMatch(/oldest/)
  })

  test('a new edit clears the redo stack', () => {
    let s = deleteCharUnderCursor(createEditorState('abc')) // 'bc'
    s = undo(s) // back to 'abc'
    expect(s.redo.length).toBe(1)
    s = deleteCharUnderCursor(s) // edit again → redo cleared
    expect(s.redo.length).toBe(0)
  })
})

describe('ex commands', () => {
  test('parseExCommand covers w/q/wq variants, goto and invalid', () => {
    expect(parseExCommand('w')).toEqual({ kind: 'write', force: false })
    expect(parseExCommand('w!')).toEqual({ kind: 'write', force: true })
    expect(parseExCommand('q')).toEqual({ kind: 'quit', force: false })
    expect(parseExCommand('q!')).toEqual({ kind: 'quit', force: true })
    expect(parseExCommand('wq')).toEqual({ kind: 'writeQuit', force: false })
    expect(parseExCommand('x')).toEqual({ kind: 'writeQuit', force: false })
    expect(parseExCommand('42')).toEqual({ kind: 'goto', line: 42 })
    expect(parseExCommand('')).toEqual({ kind: 'none' })
    expect(parseExCommand('nope')).toEqual({ kind: 'invalid', raw: 'nope' })
  })

  test('gotoLine clamps to the buffer (1-based)', () => {
    const s = createEditorState(text)
    expect(gotoLine(s, 2).cursor.row).toBe(1)
    expect(gotoLine(s, 999).cursor.row).toBe(2)
    expect(gotoLine(s, 0).cursor.row).toBe(0)
  })

  test('gotoLine clamps negative input to row 0', () => {
    expect(gotoLine(createEditorState(text), -5).cursor.row).toBe(0)
  })
})

describe('boundary / regression gaps', () => {
  test('undo restores the cursor, not just the buffer', () => {
    let s = createEditorState(text)
    s = moveDown(s) // row 1
    s = deleteLine(s)
    expect(s.cursor.row).toBe(1)
    s = undo(s)
    expect(s.lines).toEqual(['alpha', 'bravo', 'charlie'])
    expect(s.cursor.row).toBe(1) // cursor restored to where the edit happened
  })

  test('paste into a single empty line', () => {
    let s = createEditorState('')
    s.register = ['hello']
    s = pasteAfter(s)
    expect(s.lines).toEqual(['', 'hello'])
    expect(s.cursor.row).toBe(1)
  })

  test('pasteBefore lands the cursor on the first pasted line', () => {
    let s = createEditorState('a\nb')
    s = moveDown(s) // row 1 ('b')
    s.register = ['X', 'Y']
    s = pasteBefore(s)
    expect(s.lines).toEqual(['a', 'X', 'Y', 'b'])
    expect(s.cursor.row).toBe(1)
  })

  test('wordForward on the last word stays in range (no overflow)', () => {
    let s = createEditorState('foo bar')
    s = moveLineEnd(s) // col 6 (last char)
    s = wordForward(s)
    expect(s.cursor.row).toBe(0)
    expect(s.cursor.col).toBeLessThanOrEqual(6)
  })
})

describe('insert-session dirty hygiene (lazy snapshot)', () => {
  test('bare i<Esc> with no typing leaves the buffer clean', () => {
    let s = createEditorState(text)
    s = enterInsert(s, 'i')
    s = leaveInsert(s)
    expect(s.dirty).toBe(false)
    expect(s.undo.length).toBe(0)
  })

  test('first keystroke after i takes the snapshot; whole session is one undo', () => {
    let s = createEditorState('')
    s = enterInsert(s, 'i')
    expect(s.dirty).toBe(false) // deferred until the first edit
    s = insertText(s, 'h')
    s = insertText(s, 'i')
    expect(s.lines).toEqual(['hi'])
    expect(s.dirty).toBe(true)
    expect(s.undo.length).toBe(1) // not one snapshot per keystroke
    s = undo(s)
    expect(s.lines).toEqual([''])
  })

  test('backspace at the buffer start is a no-op (no dirty, no undo)', () => {
    let s = createEditorState('abc')
    s = enterInsert(s, 'I') // row 0, col 0
    s = backspace(s)
    expect(s.lines).toEqual(['abc'])
    expect(s.dirty).toBe(false)
    expect(s.undo.length).toBe(0)
  })

  test('o/O still snapshots on entry (the new blank line is undoable)', () => {
    let s = createEditorState(text)
    s = openBelow(s)
    expect(s.dirty).toBe(true)
    expect(s.lines).toEqual(['alpha', '', 'bravo', 'charlie'])
    s = undo(s)
    expect(s.lines).toEqual(['alpha', 'bravo', 'charlie'])
  })
})
