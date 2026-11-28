/**
 * Where the user is among an MCP prompt's arguments while typing them after
 * the slash command, and how picking a completed value rewrites the line.
 *
 * The finished arguments are split by `splitPromptArguments`, the function the
 * prompt is later sent with, so `"two words"` counts as one argument here
 * exactly as it does on the wire. Only the token under the cursor needs a
 * reading of its own: an opening quote that has not been closed yet is the
 * user still typing a quoted value, where the splitter would see bare words.
 */
import { splitPromptArguments } from 'src/mcp/client/promptArguments.js'
import type { PromptArgumentSpec } from 'src/shared/types/command.js'
import { truncateToWidth } from 'src/shared/text/truncate.js'

// The splitter's token shapes, plus (third) a quote left open to the end.
const TOKEN_RE = /"([^"]*)"|'([^']*)'|["']([\s\S]*)$|(\S+)/g
const WHITESPACE_RE = /\s/
const WHITESPACE_RUN_RE = /\s+/g
const QUOTE_START_RE = /^["']/
const LEADING_WORD_RE = /^\S*/
const DESCRIPTION_WIDTH = 60

export type PromptArgumentPosition = {
  /** Position of the argument being typed in `argNames`. */
  index: number
  name: string
  /** What is typed of it so far, without its quotes. */
  partial: string
  /** Offset in the text where its token starts (at the cursor when none is typed). */
  start: number
  /** The arguments before it, by name. */
  filled: Record<string, string>
}

/**
 * The argument the user is typing in `text` (everything after the command
 * name) with the cursor at `cursor`, or null once every argument is typed.
 */
export function locatePromptArgument(
  text: string,
  cursor: number,
  argNames: readonly string[],
): PromptArgumentPosition | null {
  const before = text.slice(0, cursor)
  let start = before.length
  let partial = ''
  for (const match of before.matchAll(TOKEN_RE)) {
    if (match.index + match[0].length === before.length) {
      start = match.index
      partial = match[1] ?? match[2] ?? match[3] ?? match[4]!
    }
  }

  const done = before.slice(0, start)
  const values = done.trim() === '' ? [] : splitPromptArguments(done)
  const index = values.length
  if (index >= argNames.length) return null
  const filled = Object.fromEntries(
    argNames.slice(0, index).map((name, i) => [name, values[i]!]),
  )
  return { index, name: argNames[index]!, partial, start, filled }
}

/**
 * A value as an argument token: quoted when it holds whitespace, is empty, or
 * starts with a quote, with whichever quote it does not contain. A value with
 * whitespace and both quotes cannot be grouped and goes as typed.
 */
export function quotePromptArgument(value: string): string {
  if (value !== '' && !WHITESPACE_RE.test(value) && !QUOTE_START_RE.test(value)) {
    return value
  }
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  return value
}

/**
 * Replaces the token from `start` to the cursor (and the rest of the word the
 * cursor sits in) with `value`, followed by one space so the next argument
 * starts there; the cursor lands after that space.
 */
export function acceptPromptArgumentValue(
  text: string,
  cursor: number,
  start: number,
  value: string,
): { text: string; cursor: number } {
  const head = text.slice(0, start) + quotePromptArgument(value) + ' '
  const rest = text.slice(cursor).replace(LEADING_WORD_RE, '').trimStart()
  return { text: head + rest, cursor: head.length }
}

/**
 * The hint for the arguments from `index` on: `<required>` and `[optional]`,
 * then the description of the one being typed, on a single line.
 */
export function formatPromptArgumentHint(
  specs: readonly PromptArgumentSpec[],
  index: number,
): string | undefined {
  const remaining = specs.slice(index)
  if (remaining.length === 0) return undefined
  const names = remaining
    .map(spec => (spec.required ? `<${spec.name}>` : `[${spec.name}]`))
    .join(' ')
  const description = remaining[0]!.description?.replace(WHITESPACE_RUN_RE, ' ').trim()
  return description ? `${names} · ${truncateToWidth(description, DESCRIPTION_WIDTH)}` : names
}
