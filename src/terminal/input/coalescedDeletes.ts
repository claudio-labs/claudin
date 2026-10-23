import type { Cursor } from 'src/terminal/input/Cursor.js'

// SSH and tmux can deliver backspace as raw DEL characters inside one read
// instead of as backspace key events, mixed with the text typed around them
// (`abc\x7f`). The read is applied in order: text is inserted, and each DEL
// deletes the token before the cursor (an image chip) when there is one, else
// one character.
export function applyCoalescedDeletes(cursor: Cursor, input: string): Cursor {
  let next = cursor
  input.split('\x7f').forEach((text, i) => {
    if (i > 0) next = next.deleteTokenBefore() ?? next.backspace()
    if (text) next = next.insert(text)
  })
  return next
}
