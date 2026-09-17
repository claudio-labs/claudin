type TriggerPosition = { word: string; start: number; end: number }

const OPEN_TO_CLOSE: Record<string, string> = {
  '`': '`',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'",
}

/**
 * Find keyword positions, skipping occurrences that are clearly not a
 * launch directive:
 *
 * - Inside paired delimiters: backticks, double quotes, angle brackets
 *   (tag-like only, so `n < 5 ultrareview n > 10` is not a phantom
 *   range), curly braces, square brackets, parentheses. Single quotes
 *   are delimiters only when not an apostrophe — the opening quote must
 *   be preceded by a non-word char (or start) and the closing quote
 *   must be followed by a non-word char (or end), so "let's ultrareview
 *   it's" still triggers.
 *
 * - Path/identifier-like context: immediately preceded or followed by
 *   `/`, `\`, or `-`, or followed by `.` + word char (file extension).
 *   `\b` sees a boundary at `-`, so `ultrareview-s` would otherwise
 *   match. This keeps `src/ultrareview/foo.ts`, `ultrareview.tsx`, and
 *   `--ultrareview-mode` from triggering while `ultrareview.` at a
 *   sentence end still does.
 *
 * - Followed by `?`: a question about the feature shouldn't invoke it.
 *   Other sentence punctuation (`.`, `,`, `!`) still triggers.
 *
 * - Slash command input: text starting with `/` is a slash command
 *   invocation (processUserInput.ts routes it to processSlashCommand,
 *   not keyword detection), so `/rename ultrareview foo` never triggers.
 *   Without this, PromptInput would rainbow-highlight the word even
 *   though submitting the input runs /rename.
 *
 * Shape matches findThinkingTriggerPositions (thinking.ts) so
 * PromptInput treats trigger types uniformly.
 */
function findKeywordTriggerPositions(
  text: string,
  keyword: string,
): TriggerPosition[] {
  const re = new RegExp(keyword, 'i')
  if (!re.test(text)) return []
  if (text.startsWith('/')) return []
  const quotedRanges: Array<{ start: number; end: number }> = []
  let openQuote: string | null = null
  let openAt = 0
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (openQuote) {
      if (openQuote === '[' && ch === '[') {
        openAt = i
        continue
      }
      if (ch !== OPEN_TO_CLOSE[openQuote]) continue
      if (openQuote === "'" && isWord(text[i + 1])) continue
      quotedRanges.push({ start: openAt, end: i + 1 })
      openQuote = null
    } else if (
      (ch === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) ||
      (ch === "'" && !isWord(text[i - 1])) ||
      (ch !== '<' && ch !== "'" && ch in OPEN_TO_CLOSE)
    ) {
      openQuote = ch
      openAt = i
    }
  }

  const positions: TriggerPosition[] = []
  const wordRe = new RegExp(`\\b${keyword}\\b`, 'gi')
  const matches = text.matchAll(wordRe)
  for (const match of matches) {
    if (match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length
    if (quotedRanges.some(r => start >= r.start && start < r.end)) continue
    const before = text[start - 1]
    const after = text[end]
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?')
      continue
    if (after === '.' && isWord(text[end + 1])) continue
    positions.push({ word: match[0], start, end })
  }
  return positions
}

export function findUltrareviewTriggerPositions(
  text: string,
): TriggerPosition[] {
  return findKeywordTriggerPositions(text, 'ultrareview')
}
