/**
 * Parsing the tool lists that arrive on the command line
 * (--allowed-tools / --disallowed-tools / --base-tools).
 *
 * Pure string work. The parenthesis depth is the part that matters: a comma or
 * a space inside `Tool(...)` belongs to the rule content, not to the list.
 */
import { getToolsForDefaultPreset, parseToolPreset } from 'src/tools/tools.js'

const ENTRY_SEPARATORS: ReadonlySet<string> = new Set([',', ' '])

/**
 * Cuts one argv element into entries. Depth is counted, not flagged, so that
 * `Bash(f(x) y)` stays one rule: only the `)` that closes the outermost `(`
 * brings separators back into play. An unclosed `(` never returns to depth 0,
 * which keeps the rest of the element together.
 */
function cutElement(element: string): string[] {
  const pieces: string[] = []
  let piece = ''
  let depth = 0
  for (const char of element) {
    if (depth === 0 && ENTRY_SEPARATORS.has(char)) {
      pieces.push(piece)
      piece = ''
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')' && depth > 0) depth -= 1
    piece += char
  }
  pieces.push(piece)
  return pieces
}

export function parseToolListFromCLI(tools: string[]): string[] {
  return tools
    .flatMap(cutElement)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  const asOneString = baseTools.join(' ').trim()
  if (parseToolPreset(asOneString) === 'default') {
    return getToolsForDefaultPreset()
  }
  return parseToolListFromCLI(baseTools)
}
