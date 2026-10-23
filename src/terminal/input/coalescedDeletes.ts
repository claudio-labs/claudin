import type { Cursor } from 'src/terminal/input/Cursor.js'

const DEL_CHAR_RE = /\x7f/g

// SSH and tmux can deliver backspace as raw DEL characters inside one read
// instead of as backspace key events. Each DEL deletes the token before the
// cursor (an image chip) when there is one, else one character.
export function applyCoalescedDeletes(cursor: Cursor, input: string): Cursor {
  const delCount = (input.match(DEL_CHAR_RE) || []).length
  let next = cursor
  for (let i = 0; i < delCount; i++) {
    next = next.deleteTokenBefore() ?? next.backspace()
  }
  return next
}
