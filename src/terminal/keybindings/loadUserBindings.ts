/**
 * Keybinding loader. Claudin runs on the default bindings: there is no user
 * keybindings file to read, merge or watch.
 */

import { DEFAULT_BINDINGS } from 'src/terminal/keybindings/defaultBindings.js'
import { parseBindings } from 'src/terminal/keybindings/parser.js'
import type { ParsedBinding } from 'src/terminal/keybindings/types.js'

let cachedBindings: ParsedBinding[] | null = null

/**
 * The parsed default bindings, parsed once and cached.
 */
export function loadKeybindingsSync(): ParsedBinding[] {
  if (!cachedBindings) {
    cachedBindings = parseBindings(DEFAULT_BINDINGS)
  }
  return cachedBindings
}
