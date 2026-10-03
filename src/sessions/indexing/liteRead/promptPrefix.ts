/**
 * The last-resort title of a listed session: the start of the first string
 * member `key` in raw JSONL text, read without parsing. It is what is left
 * when the head window holds no line the title reader can parse, such as a
 * first prompt longer than the window.
 */

const QUOTE = '"'
const BACKSLASH = '\\'
/** Escapes that would break a one-line title; every other escape stays as written. */
const SPACED_ESCAPES = new Set(['n', 't'])

function valueStartOf(text: string, key: string): number {
  const starts = [`"${key}":"`, `"${key}": "`]
    .map(opener => {
      const at = text.indexOf(opener)
      return at === -1 ? -1 : at + opener.length
    })
    .filter(at => at !== -1)
  return starts.length === 0 ? -1 : Math.min(...starts)
}

/**
 * Up to `maxLen` characters of the value, stopping at its closing quote when
 * the text holds one. `\n` and `\t` escapes become spaces; the result is
 * trimmed. `''` when the member is not there.
 */
export function stringMemberPrefix(text: string, key: string, maxLen: number): string {
  const start = valueStartOf(text, key)
  if (start === -1) return ''
  let prefix = ''
  for (let i = start; i < text.length && prefix.length < maxLen; i++) {
    const char = text[i]!
    if (char === QUOTE) break
    if (char !== BACKSLASH) {
      prefix += char
      continue
    }
    const escaped = text[i + 1]
    if (escaped === undefined) break
    prefix += SPACED_ESCAPES.has(escaped) ? ' ' : char + escaped
    i++
  }
  return prefix.slice(0, maxLen).trim()
}
